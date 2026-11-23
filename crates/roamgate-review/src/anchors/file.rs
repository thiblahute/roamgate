//! Threads on a file's lines placed where they are in the file as it reads
//! now (shared/fileAnchors.ts, the server's half; the Files preview keeps
//! its own TS copy), held to contract/vectors/file-anchors.json.

use std::sync::LazyLock;

use serde_json::{Value, json};

use super::{note_of, note_text};
use crate::js::{head16, len16};
use crate::model::ReviewAnchor;

/// How many of a quote's first units say where it is (kept, or by text).
pub const QUOTE_HEAD_UNITS: usize = 48;
/// How many of a quote's first words a reworded thread is found by.
pub const QUOTE_HEAD_WORDS: usize = 8;
const HEAD_SHARE: f64 = 0.6;
const SHORT_HEAD_WORDS: usize = 4;
const LINE_HEAD_WORDS: usize = 2;
const CONTINUES_UNITS: usize = 12;

static LINK: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r"!?\[([^\]]*)\]\([^)]*\)").unwrap());
static NOT_TOKEN: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r"[^\p{L}\p{N}]+").unwrap());

fn not_words(ch: char) -> bool {
    crate::js::js_space(ch) || matches!(ch, '`' | '*' | '_' | '~' | '#' | '>' | '|' | '\\')
}

/// One unit as quotes are compared: lower case, when that keeps it one.
pub fn word_unit(ch: char) -> String {
    let lower: String = ch.to_lowercase().collect();
    if len16(&lower) == 1 {
        lower
    } else {
        ch.to_string()
    }
}

/// The words a quote is found by (quoteWords).
pub fn quote_words(text: &str) -> String {
    let unlinked = LINK.replace_all(text, "$1");
    unlinked
        .chars()
        .filter(|ch| !not_words(*ch))
        .map(word_unit)
        .collect()
}

fn tokens_of(text: &str) -> Vec<String> {
    NOT_TOKEN
        .split(&text.to_lowercase())
        .filter(|token| !token.is_empty())
        .map(str::to_owned)
        .collect()
}

/// The longest run of `head`'s words read in `tokens` in their order, and
/// the first token an alignment that long can start on.
fn common_run(head: &[String], tokens: &[String]) -> (usize, usize) {
    let n = head.len();
    let m = tokens.len();
    let mut longest = vec![vec![0usize; m + 1]; n + 1];
    for i in (0..n).rev() {
        for j in (0..m).rev() {
            longest[i][j] = if head[i] == tokens[j] {
                longest[i + 1][j + 1] + 1
            } else {
                longest[i + 1][j].max(longest[i][j + 1])
            };
        }
    }
    let length = longest[0][0];
    let (mut i, mut j) = (0, 0);
    while i < n && j < m {
        if head[i] == tokens[j] && longest[i][j] == longest[i + 1][j + 1] + 1 {
            return (length, j);
        }
        if longest[i + 1][j] == longest[i][j] {
            i += 1;
        } else {
            j += 1;
        }
    }
    (length, m)
}

/// The words a thread quotes from the file, when it quotes words.
pub fn anchor_quote(anchor: &ReviewAnchor) -> Option<String> {
    if let Some(render) = &anchor.render {
        if render.graphic.as_deref().is_some_and(|s| !s.is_empty())
            || render.region.is_some()
            || render.element.as_deref().is_some_and(|s| !s.is_empty())
            || render.selector.as_deref().is_some_and(|s| !s.is_empty())
        {
            return None;
        }
        return render.quote.clone().filter(|quote| !quote.is_empty());
    }
    let note = note_of(anchor)?;
    if note.get("source").and_then(Value::as_str) != Some("file") {
        return None;
    }
    note.get("quote")
        .and_then(Value::as_str)
        .filter(|quote| !quote.is_empty())
        .map(str::to_owned)
}

/// A thread's place in the file as it reads now.
#[derive(Debug, Clone, PartialEq)]
pub struct FilePlace {
    pub line: i64,
    pub end_line: Option<i64>,
    pub text: String,
    pub quote: Option<String>,
    /// "kept", "text" or "words".
    pub how: &'static str,
}

impl FilePlace {
    pub fn to_value(&self) -> Value {
        let mut map = serde_json::Map::new();
        map.insert("line".into(), json!(self.line));
        if let Some(end) = self.end_line {
            map.insert("endLine".into(), json!(end));
        }
        map.insert("text".into(), json!(self.text));
        if let Some(quote) = &self.quote {
            map.insert("quote".into(), json!(quote));
        }
        map.insert("how".into(), json!(self.how));
        Value::Object(map)
    }
}

struct Rule {
    pattern: fancy_regex::Regex,
    replace: &'static str,
}

static RENDERED_RULES: LazyLock<Vec<Rule>> = LazyLock::new(|| {
    [
        (r"^\s*(?:>\s*)*", ""),
        (r"^(?:[-*+]|[0-9]+[.)])\s+(?:\[[ xX]\]\s+)?", ""),
        (r"^#{1,6}\s+", ""),
        (r"!?\[([^\]]*)\]\([^)]*\)", "$1"),
        (r"(\*\*|__)(.+?)\1", "$2"),
        (r"~~(.+?)~~", "$1"),
        (r"(^|[^A-Za-z0-9_\\])\*([^*\s][^*]*?)\*", "$1$2"),
        (
            r"(^|[^A-Za-z0-9_\\])_([^_\s][^_]*?)_(?![A-Za-z0-9_])",
            "$1$2",
        ),
        (r"`([^`]*)`", "$1"),
        (r"\\([\\`*_{}\[\]()#+\-.!>~|])", "$1"),
        (r"\s+$", ""),
    ]
    .into_iter()
    .map(|(pattern, replace)| Rule {
        pattern: fancy_regex::Regex::new(pattern).unwrap(),
        replace,
    })
    .collect()
});

/// The words of some source lines as a Markdown preview shows them, near
/// enough (renderedWords).
pub fn rendered_words(lines: &[String]) -> String {
    let rendered: Vec<String> = lines
        .iter()
        .map(|line| {
            let mut text = line.clone();
            for rule in RENDERED_RULES.iter() {
                text = rule.pattern.replace_all(&text, rule.replace).into_owned();
            }
            text
        })
        .filter(|line| !line.is_empty())
        .collect();
    crate::js::trim(&rendered.join("\n")).to_owned()
}

/// Where the anchor's thread is in `lines` (placeInFile).
pub fn place_in_file(anchor: &ReviewAnchor, lines: &[String]) -> Option<FilePlace> {
    if anchor.side.as_deref() == Some("old") {
        return None;
    }
    let (line, end_line, text) = (anchor.line, anchor.end_line, anchor.text.as_deref());
    let quote = anchor_quote(anchor);
    let all = quote.as_deref().map(quote_words).unwrap_or_default();
    let head = head16(&all, QUOTE_HEAD_UNITS);
    let span = match (line, end_line) {
        (Some(line), Some(end)) => end - line,
        _ => 0,
    };
    let words: Vec<String> = lines.iter().map(|line| quote_words(line)).collect();
    let span_words = |start: i64, end: i64| -> String {
        let from = (start - 1).max(0) as usize;
        let to = (end.max(0) as usize).min(words.len());
        if from >= to {
            String::new()
        } else {
            words[from..to].concat()
        }
    };
    let target = end_line.or(line);
    if let (Some(line), Some(target)) = (line, target) {
        let at = (target >= 1)
            .then(|| lines.get((target - 1) as usize))
            .flatten();
        if let Some(at) = at {
            let reads = text.is_none_or(|text| at == text);
            let holds = head.is_empty() || span_words(line, target).contains(&head);
            if reads && holds {
                return Some(FilePlace {
                    line,
                    end_line,
                    text: at.clone(),
                    quote: quote.clone(),
                    how: "kept",
                });
            }
        }
    }
    if let Some(text) = text {
        let mut best: Option<(i64, i64)> = None;
        for (index, each) in lines.iter().enumerate() {
            if each != text {
                continue;
            }
            let end = index as i64 + 1;
            let start = end - span;
            if start < 1 || (!head.is_empty() && !span_words(start, end).contains(&head)) {
                continue;
            }
            let distance = match target {
                None => end,
                Some(target) => (end - target).abs(),
            };
            if best.is_none_or(|(_, best)| distance < best) {
                best = Some((end, distance));
            }
        }
        if let Some((end, _)) = best {
            return Some(FilePlace {
                line: end - span,
                end_line: (span != 0).then_some(end),
                text: text.to_owned(),
                quote: quote.clone(),
                how: "text",
            });
        }
    }
    if head.is_empty() {
        return None;
    }
    let quote = quote?;
    let head_words: Vec<String> = tokens_of(&quote)
        .into_iter()
        .take(QUOTE_HEAD_WORDS)
        .collect();
    if head_words.is_empty() {
        return None;
    }
    let needed = if head_words.len() < SHORT_HEAD_WORDS {
        head_words.len()
    } else {
        (head_words.len() as f64 * HEAD_SHARE).ceil() as usize
    };
    let tokens: Vec<Vec<String>> = lines.iter().map(|line| tokens_of(line)).collect();
    let mut best: Option<(i64, usize, i64)> = None;
    for (index, own) in tokens.iter().enumerate() {
        if own.is_empty() {
            continue;
        }
        if head_words.len() <= LINE_HEAD_WORDS && own.len() != head_words.len() {
            continue;
        }
        let mut window = own.clone();
        for next in [index + 1, index + 2] {
            if let Some(more) = tokens.get(next) {
                window.extend(more.iter().cloned());
            }
        }
        let (length, start) = common_run(&head_words, &window);
        if length < needed || start >= own.len() {
            continue;
        }
        let start = index as i64 + 1;
        let distance = match line {
            None => start,
            Some(line) => (start - line).abs(),
        };
        let better = match best {
            None => true,
            Some((_, matched, best_distance)) => {
                length > matched || (length == matched && distance < best_distance)
            }
        };
        if better {
            best = Some((start, length, distance));
        }
    }
    let (found, _, _) = best?;
    let mut end = found;
    while (end as usize) < lines.len() {
        let next = &words[end as usize];
        if next.is_empty() || !all.contains(&head16(next, CONTINUES_UNITS)) {
            break;
        }
        end += 1;
    }
    let verbatim = span_words(found, end).contains(&all);
    let quote = if verbatim {
        quote
    } else {
        let rendered = rendered_words(&lines[(found - 1) as usize..end as usize]);
        if rendered.is_empty() { quote } else { rendered }
    };
    Some(FilePlace {
        line: found,
        end_line: (end > found).then_some(end),
        text: lines[(end - 1) as usize].clone(),
        quote: Some(quote),
        how: "words",
    })
}

/// The anchor at `place` (anchorAt).
pub fn anchor_at(anchor: &ReviewAnchor, place: &FilePlace) -> ReviewAnchor {
    let mut next = anchor.clone();
    next.line = Some(place.line);
    next.text = Some(place.text.clone());
    next.end_line = place.end_line;
    if let (Some(quote), Some(render)) = (&place.quote, &anchor.render)
        && render.quote.is_some()
    {
        let mut render = render.clone();
        render.quote = Some(quote.clone());
        next.render = Some(render);
    }
    if let Some(mut note) = note_of(anchor) {
        note.insert("line".into(), json!(place.line));
        match place.end_line {
            Some(end) => {
                note.insert("endLine".into(), json!(end));
            }
            None => {
                note.shift_remove("endLine");
            }
        }
        if let Some(quote) = &place.quote
            && note.get("quote").is_some_and(Value::is_string)
        {
            note.insert("quote".into(), json!(quote));
        }
        next.feedback = Some(note_text(&note));
    }
    next
}

/// The anchor off its lines, its text and words kept (anchorDetached).
pub fn anchor_detached(anchor: &ReviewAnchor) -> ReviewAnchor {
    let mut next = anchor.clone();
    next.line = None;
    next.end_line = None;
    if let Some(mut note) = note_of(anchor) {
        note.shift_remove("line");
        note.shift_remove("endLine");
        next.feedback = Some(note_text(&note));
    }
    next
}

/// Whether the thread was written in the Files preview.
pub fn written_in_file(anchor: &ReviewAnchor) -> bool {
    note_of(anchor)
        .and_then(|note| {
            note.get("source")
                .and_then(Value::as_str)
                .map(|s| s == "file")
        })
        .unwrap_or(false)
}

/// Whether `anchor` is on the file's lines, or was.
pub fn anchored_in_file(anchor: &ReviewAnchor) -> bool {
    anchor.path.as_deref().is_some_and(|path| !path.is_empty())
        && anchor.message.is_none()
        && anchor.chat.is_none()
        && anchor.effort.is_none()
        && anchor.terminal.is_none()
        && anchor.side.as_deref() != Some("old")
        && (anchor.line.is_some() || anchor.text.is_some() || anchor_quote(anchor).is_some())
}

/// The anchor as the file reads now; `None` when nothing is to change.
pub fn anchor_in_file(anchor: &ReviewAnchor, lines: &[String]) -> Option<ReviewAnchor> {
    if !anchored_in_file(anchor) {
        return None;
    }
    let Some(place) = place_in_file(anchor, lines) else {
        return anchor.line.map(|_| anchor_detached(anchor));
    };
    if place.how == "kept" && anchor.text.as_deref() == Some(place.text.as_str()) {
        return None;
    }
    Some(anchor_at(anchor, &place))
}

#[cfg(test)]
mod tests {
    use super::*;
    use roamgate_protocol::vectors;

    fn anchor(value: &Value) -> ReviewAnchor {
        serde_json::from_value(value.clone()).unwrap()
    }

    fn lines(value: &Value) -> Vec<String> {
        value
            .as_array()
            .unwrap()
            .iter()
            .map(|line| vectors::text(line).unwrap())
            .collect()
    }

    fn place(value: &Value) -> FilePlace {
        FilePlace {
            line: value["line"].as_i64().unwrap(),
            end_line: value.get("endLine").and_then(Value::as_i64),
            text: value["text"].as_str().unwrap().into(),
            quote: value
                .get("quote")
                .and_then(Value::as_str)
                .map(str::to_owned),
            how: match value["how"].as_str().unwrap() {
                "kept" => "kept",
                "text" => "text",
                _ => "words",
            },
        }
    }

    #[test]
    fn file_anchors_vectors() {
        let file = vectors::load("file-anchors");
        for case in &file.cases {
            for call in &case.calls {
                let got = match call.target().as_str() {
                    "fileAnchors.placeInFile" => {
                        place_in_file(&anchor(&call.args[0]), &lines(&call.args[1]))
                            .map(|place| place.to_value())
                            .unwrap_or(Value::Null)
                    }
                    "fileAnchors.anchorInFile" => {
                        anchor_in_file(&anchor(&call.args[0]), &lines(&call.args[1]))
                            .map(|anchor| serde_json::to_value(anchor).unwrap())
                            .unwrap_or(Value::Null)
                    }
                    "fileAnchors.anchorAt" => serde_json::to_value(anchor_at(
                        &anchor(&call.args[0]),
                        &place(&call.args[1]),
                    ))
                    .unwrap(),
                    "fileAnchors.anchorDetached" => {
                        serde_json::to_value(anchor_detached(&anchor(&call.args[0]))).unwrap()
                    }
                    "fileAnchors.anchoredInFile" => json!(anchored_in_file(&anchor(&call.args[0]))),
                    "fileAnchors.renderedWords" => json!(rendered_words(&lines(&call.args[0]))),
                    other => panic!("unknown call {other}"),
                };
                assert_eq!(
                    &got,
                    call.result.as_ref().unwrap_or(&Value::Null),
                    "{}",
                    case.title()
                );
            }
        }
    }
}
