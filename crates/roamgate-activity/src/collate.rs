//! `String.prototype.localeCompare` as the Bun server runs it (ICU's root
//! collation, no options) for the strings the timeline sorts: workspace
//! ids, agent names, pane ids and subject labels. Not a full UCA: the
//! primary level orders white space, then punctuation and symbols, then
//! digits, then letters case-insensitively (accents folded for Latin-1 and
//! Latin Extended-A letters); the tertiary level puts lower case before
//! upper case; code points break the remaining ties. U+FFFF sorts last, as
//! the timeline's "no label" sentinel needs.

use std::cmp::Ordering;

fn fold(ch: char) -> char {
    let base = match ch {
        'À'..='Å' | 'à'..='å' | 'Ā'..='ą' => 'a',
        'Ç' | 'ç' | 'Ć'..='č' => 'c',
        'Ď'..='đ' => 'd',
        'È'..='Ë' | 'è'..='ë' | 'Ē'..='ě' => 'e',
        'Ĝ'..='ģ' => 'g',
        'Ĥ'..='ħ' => 'h',
        'Ì'..='Ï' | 'ì'..='ï' | 'Ĩ'..='ı' => 'i',
        'Ĵ' | 'ĵ' => 'j',
        'Ķ' | 'ķ' => 'k',
        'Ĺ'..='ł' => 'l',
        'Ñ' | 'ñ' | 'Ń'..='ň' => 'n',
        'Ò'..='Ö' | 'Ø' | 'ò'..='ö' | 'ø' | 'Ō'..='ő' => 'o',
        'Ŕ'..='ř' => 'r',
        'Ś'..='š' => 's',
        'Ţ'..='ŧ' => 't',
        'Ù'..='Ü' | 'ù'..='ü' | 'Ũ'..='ų' => 'u',
        'Ŵ' | 'ŵ' => 'w',
        'Ý' | 'ý' | 'ÿ' | 'Ŷ'..='Ÿ' => 'y',
        'Ź'..='ž' => 'z',
        other => other,
    };
    base.to_lowercase().next().unwrap_or(base)
}

/// ASCII punctuation and symbols in the root collation's order.
const PUNCTUATION: &str = "_-,;:!?.'\"()[]{}@*/\\&#%`^+<=>|~$";

/// The primary weight of a character: (group, folded character).
fn primary(ch: char) -> (u8, char) {
    if ch == '\u{ffff}' {
        return (5, ch);
    }
    if let Some(index) = PUNCTUATION.find(ch) {
        return (1, char::from(index as u8));
    }
    let folded = fold(ch);
    let group = if ch.is_whitespace() {
        0
    } else if ch.is_ascii_punctuation() || (!ch.is_alphanumeric() && !ch.is_control()) {
        1
    } else if ch.is_numeric() {
        2
    } else if ch.is_alphabetic() {
        3
    } else {
        4
    };
    (group, folded)
}

/// `a.localeCompare(b)`.
pub fn locale_compare(a: &str, b: &str) -> Ordering {
    let primary_a: Vec<_> = a.chars().map(primary).collect();
    let primary_b: Vec<_> = b.chars().map(primary).collect();
    primary_a
        .cmp(&primary_b)
        .then_with(|| {
            // Accents, then case: lower case first.
            let secondary = |text: &str| {
                text.chars()
                    .map(|ch| ch.to_lowercase().next().unwrap_or(ch))
                    .collect::<Vec<_>>()
            };
            secondary(a).cmp(&secondary(b))
        })
        .then_with(|| {
            let tertiary =
                |text: &str| text.chars().map(|ch| ch.is_uppercase()).collect::<Vec<_>>();
            tertiary(a).cmp(&tertiary(b))
        })
        .then_with(|| a.cmp(b))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn orders_like_the_root_collation() {
        let mut words = vec![
            "b", "B", "a", "ws_2", "ws-1", "10", "9", "\u{ffff}", "Émile", "eric", " x",
        ];
        words.sort_by(|a, b| locale_compare(a, b));
        assert_eq!(
            words,
            vec![
                " x", "10", "9", "a", "b", "B", "Émile", "eric", "ws_2", "ws-1", "\u{ffff}"
            ]
        );
    }
}
