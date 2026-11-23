//! Numbers written out as words before Pocket TTS reads a sentence: its
//! models read words, and read digits badly or not at all ("12h30", "3,5 %",
//! "0.9.5" came out mangled in French). Qwen3-TTS and Kokoro read digits
//! themselves; Pocket TTS gets the sentence with its numbers spelled in the
//! sentence's language.
//!
//! French and English are written out: integers (French's "1 000" and
//! English's "1,000" grouping), decimals (French's comma, a dot read
//! "point"), versions ("0.9.5"), ordinals ("1er", "21e", "2nd", "3rd"),
//! times ("12h30", "8:05"), dates ("2026-11-23", French's "23/11/2026"),
//! percentages, signs, ranges ("10-20"), dimensions ("1920x1080"), money
//! and units ("5 km", "3 Go", "21 °C"). A number in a word ("Qwen3", "5G")
//! is read as a number beside its letters. Other languages are left as
//! they are. The cases are contract/vectors/pocket-spoken-numbers.json.

use super::primary;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Lang {
    Fr,
    En,
}

/// `text` with its numbers written out in `language`: unchanged in a
/// language other than French or English.
pub fn spell_out(text: &str, language: &str) -> String {
    let lang = match primary(language).as_str() {
        "fr" => Lang::Fr,
        "en" => Lang::En,
        _ => return text.to_string(),
    };
    if !text.chars().any(|c| c.is_ascii_digit()) {
        return text.to_string();
    }
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::with_capacity(text.len() * 2);
    let mut i = 0;
    while i < chars.len() {
        if let Some((spoken, next)) = number_at(&chars, i, lang) {
            if out.chars().last().is_some_and(char::is_alphanumeric) {
                out.push(' ');
            }
            out.push_str(&spoken);
            if chars.get(next).is_some_and(|c| c.is_alphanumeric()) {
                out.push(' ');
            }
            i = next;
            continue;
        }
        out.push(chars[i]);
        i += 1;
    }
    out
}

fn is_digit(chars: &[char], at: usize) -> bool {
    chars.get(at).is_some_and(char::is_ascii_digit)
}

fn is_letter(chars: &[char], at: usize) -> bool {
    chars.get(at).is_some_and(|c| c.is_alphabetic())
}

/// Whether nothing word-like goes on at `at`: the end, a space,
/// punctuation.
fn boundary(chars: &[char], at: usize) -> bool {
    !chars
        .get(at)
        .is_some_and(|c| c.is_alphanumeric() || *c == '\'' || *c == '\u{2019}')
}

/// The run of ASCII digits at `at`, and where it ends.
fn digits_at(chars: &[char], at: usize) -> (String, usize) {
    let mut end = at;
    while is_digit(chars, end) {
        end += 1;
    }
    (chars[at..end].iter().collect(), end)
}

fn value(digits: &str) -> u64 {
    digits.parse().unwrap_or(u64::MAX)
}

/// A space a number and its unit or percent sign may have between them.
fn is_space(c: char) -> bool {
    matches!(c, ' ' | '\u{a0}' | '\u{202f}')
}

/// What starts at `at`, if it is a number (with its sign, currency or
/// unit): its words and where it ends.
fn number_at(chars: &[char], at: usize, lang: Lang) -> Option<(String, usize)> {
    let c = chars[at];
    let prev = at.checked_sub(1).map(|p| chars[p]);
    let word_start = prev.is_none_or(|p| !p.is_alphanumeric());
    // A currency before the amount: "€5", "$3.50".
    if let Some(currency) = currency_sign(c)
        && is_digit(chars, at + 1)
        && word_start
    {
        let (amount, end) = plain_number(chars, at + 1, lang)?;
        return Some((money(&amount, currency, lang), end));
    }
    // A sign: "-5", "+3 %", "−2 °C".
    if matches!(c, '-' | '\u{2212}' | '+')
        && is_digit(chars, at + 1)
        && prev.is_none_or(|p| p.is_whitespace() || matches!(p, '(' | '[' | '/' | '='))
    {
        let (rest, end) = number_at(chars, at + 1, lang)?;
        let sign = match (c, lang) {
            ('+', Lang::Fr) => "plus",
            ('+', Lang::En) => "plus",
            (_, Lang::Fr) => "moins",
            (_, Lang::En) => "minus",
        };
        return Some((format!("{sign} {rest}"), end));
    }
    // About: "~5 min", "≈ 3 Go".
    if matches!(c, '~' | '\u{2248}') && word_start {
        let start = if chars.get(at + 1).is_some_and(|c| is_space(*c)) {
            at + 2
        } else {
            at + 1
        };
        if is_digit(chars, start) {
            let (rest, end) = number_at(chars, start, lang)?;
            let about = match lang {
                Lang::Fr => "environ",
                Lang::En => "about",
            };
            return Some((format!("{about} {rest}"), end));
        }
    }
    // A number: "#42", French's "n°3".
    let numbered = match c {
        '#' => Some(at + 1),
        'n' | 'N' if chars.get(at + 1) == Some(&'°') => Some(at + 2),
        _ => None,
    };
    if let Some(start) = numbered
        && word_start
        && is_digit(chars, start)
    {
        let (digits, end) = digits_at(chars, start);
        let word = match lang {
            Lang::Fr => "numéro",
            Lang::En => "number",
        };
        return Some((format!("{word} {}", integer(&digits, lang, false)), end));
    }
    // A version: "v0.9.5".
    if matches!(c, 'v' | 'V') && word_start && is_digit(chars, at + 1) {
        let (rest, end) = number_at(chars, at + 1, lang)?;
        return Some((format!("version {rest}"), end));
    }
    if !c.is_ascii_digit() {
        return None;
    }
    // In a word ("Qwen3", "x86", "COVID-19" after its dash): its digits
    // as a number, a version or a decimal at most.
    if prev.is_some_and(char::is_alphabetic) {
        let (spoken, end) = dotted(chars, at, lang).unwrap_or_else(|| {
            let (digits, end) = digits_at(chars, at);
            (integer(&digits, lang, false), end)
        });
        return Some((spoken, end));
    }
    if let Some(found) = date(chars, at, lang) {
        return Some(found);
    }
    if let Some(found) = time(chars, at, lang) {
        return Some(found);
    }
    if let Some(found) = dotted(chars, at, lang) {
        return Some(found);
    }
    let (number, mut end) = plain_number(chars, at, lang)?;
    let mut spoken = None;
    // A percentage.
    let spaced = if chars.get(end).is_some_and(|c| is_space(*c)) {
        end + 1
    } else {
        end
    };
    if chars.get(spaced) == Some(&'%') {
        let percent = match lang {
            Lang::Fr => "pour cent",
            Lang::En => "percent",
        };
        return Some((
            format!("{} {percent}", number.words(lang, false)),
            spaced + 1,
        ));
    }
    if number.fraction.is_none() {
        // An ordinal: "1er", "21e", "2nd", "3rd".
        if let Some((words, after)) = ordinal(chars, end, &number.integer, lang) {
            return Some((words, after));
        }
        // Times: "2x".
        if matches!(chars.get(end), Some('x' | '\u{d7}')) && boundary(chars, end + 1) {
            let times = match lang {
                Lang::Fr => "fois",
                Lang::En => "times",
            };
            return Some((
                format!("{} {times}", integer(&number.integer, lang, false)),
                end + 1,
            ));
        }
        // A dimension: "1920x1080", "3 × 4".
        let by = match chars.get(end) {
            Some('x' | '\u{d7}') if is_digit(chars, end + 1) => Some(end + 1),
            Some(c) if is_space(*c) => match chars.get(end + 1) {
                Some('x' | '\u{d7}')
                    if chars.get(end + 2).is_some_and(|c| is_space(*c))
                        && is_digit(chars, end + 3) =>
                {
                    Some(end + 3)
                }
                _ => None,
            },
            _ => None,
        };
        if let Some(next) = by
            && let Some((other, after)) = number_at(chars, next, lang)
        {
            let by = match lang {
                Lang::Fr => "par",
                Lang::En => "by",
            };
            return Some((
                format!("{} {by} {other}", integer(&number.integer, lang, false)),
                after,
            ));
        }
        // A range: "10-20", "2024–2026".
        if matches!(chars.get(end), Some('-' | '\u{2013}'))
            && is_digit(chars, end + 1)
            && let Some((other, after)) = number_at(chars, end + 1, lang)
        {
            let to = match lang {
                Lang::Fr => "à",
                Lang::En => "to",
            };
            return Some((
                format!("{} {to} {other}", integer(&number.integer, lang, false)),
                after,
            ));
        }
        // A fraction or a score, in French: "8/10".
        if lang == Lang::Fr
            && chars.get(end) == Some(&'/')
            && is_digit(chars, end + 1)
            && word_start
        {
            let (other, after) = digits_at(chars, end + 1);
            if boundary(chars, after) && chars.get(after) != Some(&'/') {
                return Some((
                    format!(
                        "{} sur {}",
                        integer(&number.integer, lang, false),
                        integer(&other, lang, false)
                    ),
                    after,
                ));
            }
        }
    }
    // A currency or a unit after it.
    if let Some((unit, after)) = unit_after(chars, end, lang) {
        let words = match unit {
            Unit::Money(currency) => money(&number, currency, lang),
            Unit::Measure(unit) => {
                let feminine = lang == Lang::Fr && unit.feminine;
                let plural = number.plural(lang);
                format!(
                    "{} {}",
                    number.words(lang, feminine),
                    if plural { unit.plural } else { unit.singular }
                )
            }
        };
        spoken = Some(words);
        end = after;
    }
    Some((spoken.unwrap_or_else(|| number.words(lang, false)), end))
}

/// A number with its integer and fractional digits.
struct Number {
    integer: String,
    /// The fractional digits, when it has some.
    fraction: Option<String>,
}

impl Number {
    fn words(&self, lang: Lang, feminine: bool) -> String {
        match &self.fraction {
            None => integer(&self.integer, lang, feminine),
            Some(fraction) => {
                let whole = integer(&self.integer, lang, false);
                match lang {
                    Lang::Fr => format!("{whole} virgule {}", fraction_fr(fraction, feminine)),
                    Lang::En => format!("{whole} point {}", digit_by_digit(fraction, lang)),
                }
            }
        }
    }

    /// Whether a unit after it takes its plural: from 2 in French, all
    /// but exactly 1 in English.
    fn plural(&self, lang: Lang) -> bool {
        match lang {
            Lang::Fr => value(&self.integer) >= 2,
            Lang::En => !(self.fraction.is_none() && value(&self.integer) == 1),
        }
    }
}

/// French decimals: up to three digits as a number ("3,14": trois virgule
/// quatorze), its leading zeros said ("0,05": zéro virgule zéro cinq);
/// longer ones digit by digit.
fn fraction_fr(fraction: &str, feminine: bool) -> String {
    if fraction.len() > 3 {
        return digit_by_digit(fraction, Lang::Fr);
    }
    let zeros = fraction.len() - fraction.trim_start_matches('0').len();
    let rest = &fraction[zeros..];
    let mut words: Vec<String> = std::iter::repeat_n("zéro".to_string(), zeros).collect();
    if !rest.is_empty() {
        words.push(cardinal(value(rest), Lang::Fr, feminine));
    } else if zeros == 0 {
        words.push("zéro".into());
    }
    words.join(" ")
}

/// The number at `at`, with its thousands grouped and its decimals.
fn plain_number(chars: &[char], at: usize, lang: Lang) -> Option<(Number, usize)> {
    let (mut integer, mut end) = digits_at(chars, at);
    if integer.is_empty() {
        return None;
    }
    // Thousands: French's "1 000 000" (or with no-break spaces), English's
    // "1,000,000"; a first group of 1 to 3 digits, then groups of 3.
    if integer.len() <= 3 && !(integer.starts_with('0')) {
        let separators: &[char] = match lang {
            Lang::Fr => &[' ', '\u{a0}', '\u{202f}'],
            Lang::En => &[',', '\u{a0}', '\u{202f}'],
        };
        let mut grouped = integer.clone();
        let mut at = end;
        let mut separator = None;
        while let Some(&c) = chars.get(at) {
            if !separators.contains(&c) || separator.is_some_and(|s| s != c) {
                break;
            }
            let (group, after) = digits_at(chars, at + 1);
            if group.len() != 3 {
                break;
            }
            separator = Some(c);
            grouped.push_str(&group);
            at = after;
        }
        if at != end {
            integer = grouped;
            end = at;
        }
    }
    // Decimals: a comma in French, a dot in English.
    let decimal = match lang {
        Lang::Fr => ',',
        Lang::En => '.',
    };
    let mut fraction = None;
    if chars.get(end) == Some(&decimal) && is_digit(chars, end + 1) {
        let (digits, after) = digits_at(chars, end + 1);
        fraction = Some(digits);
        end = after;
    }
    Some((Number { integer, fraction }, end))
}

/// Dotted numbers at `at`: a version ("0.9.5": zéro point neuf point
/// cinq), French's thousands with dots ("1.000.000"), and in French a
/// number with one dot ("4.5", a version, or a decimal written the English
/// way) read with "point".
fn dotted(chars: &[char], at: usize, lang: Lang) -> Option<(String, usize)> {
    let mut parts = vec![digits_at(chars, at)];
    let mut end = parts[0].1;
    while chars.get(end) == Some(&'.') && is_digit(chars, end + 1) {
        let part = digits_at(chars, end + 1);
        end = part.1;
        parts.push(part);
    }
    if parts.len() < 2 || is_letter(chars, end) {
        return None;
    }
    let parts: Vec<String> = parts.into_iter().map(|(digits, _)| digits).collect();
    let first = &parts[0];
    if lang == Lang::Fr
        && first.len() <= 3
        && !first.starts_with('0')
        && parts[1..].iter().all(|part| part.len() == 3)
        && (parts.len() > 2 || first != "0")
    {
        // "1.000" and "1.000.000": thousands, as French writes them too.
        let joined: String = parts.concat();
        let number = Number {
            integer: joined,
            fraction: None,
        };
        if let Some((Unit::Measure(unit), after)) = unit_after(chars, end, lang) {
            return Some((
                format!(
                    "{} {}",
                    number.words(lang, unit.feminine),
                    if number.plural(lang) {
                        unit.plural
                    } else {
                        unit.singular
                    }
                ),
                after,
            ));
        }
        return Some((number.words(lang, false), end));
    }
    if parts.len() == 2 && lang == Lang::En {
        // An English decimal: plain_number reads it with its unit.
        return None;
    }
    let words: Vec<String> = parts
        .iter()
        .map(|part| integer(part, lang, false))
        .collect();
    Some((words.join(" point "), end))
}

/// A date at `at`: ISO's "2026-11-23", French's "23/11/2026".
fn date(chars: &[char], at: usize, lang: Lang) -> Option<(String, usize)> {
    let (first, end) = digits_at(chars, at);
    let (year, month, day, end) = if first.len() == 4 && chars.get(end) == Some(&'-') {
        let (month, after_month) = digits_at(chars, end + 1);
        if month.len() != 2 || chars.get(after_month) != Some(&'-') {
            return None;
        }
        let (day, after) = digits_at(chars, after_month + 1);
        if day.len() != 2 {
            return None;
        }
        (first, month, day, after)
    } else if lang == Lang::Fr && (1..=2).contains(&first.len()) && chars.get(end) == Some(&'/') {
        let (month, after_month) = digits_at(chars, end + 1);
        if !(1..=2).contains(&month.len()) || chars.get(after_month) != Some(&'/') {
            return None;
        }
        let (year, after) = digits_at(chars, after_month + 1);
        if year.len() != 4 {
            return None;
        }
        (year, month, first, after)
    } else {
        return None;
    };
    if !boundary(chars, end) || is_digit(chars, end) {
        return None;
    }
    let (m, d) = (value(&month), value(&day));
    if !(1..=12).contains(&m) || !(1..=31).contains(&d) {
        return None;
    }
    let year = integer(&year, lang, false);
    Some((
        match lang {
            Lang::Fr => {
                let day = if d == 1 {
                    "premier".to_string()
                } else {
                    cardinal(d, lang, false)
                };
                format!("{day} {} {year}", MONTHS_FR[m as usize - 1])
            }
            Lang::En => format!(
                "{} {}, {year}",
                MONTHS_EN[m as usize - 1],
                ordinal_en(&cardinal(d, lang, false))
            ),
        },
        end,
    ))
}

const MONTHS_FR: [&str; 12] = [
    "janvier",
    "février",
    "mars",
    "avril",
    "mai",
    "juin",
    "juillet",
    "août",
    "septembre",
    "octobre",
    "novembre",
    "décembre",
];

const MONTHS_EN: [&str; 12] = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
];

/// A time at `at`: "12:30", "8:05:10", and in French "12h30", "12 h 30",
/// "8h".
fn time(chars: &[char], at: usize, lang: Lang) -> Option<(String, usize)> {
    let (hours, end) = digits_at(chars, at);
    if hours.len() > 2 || value(&hours) > 24 {
        return None;
    }
    let minutes_at = |at: usize| {
        let (minutes, after) = digits_at(chars, at);
        (minutes.len() == 2 && value(&minutes) < 60 && !is_digit(chars, after))
            .then_some((minutes, after))
    };
    // "12:30", "12:30:15".
    if chars.get(end) == Some(&':')
        && let Some((minutes, after)) = minutes_at(end + 1)
    {
        let (seconds, after) = match chars.get(after) {
            Some(':') => match minutes_at(after + 1) {
                Some((seconds, after)) => (Some(seconds), after),
                None => (None, after),
            },
            _ => (None, after),
        };
        if is_letter(chars, after) {
            return None;
        }
        return Some((
            clock(
                value(&hours),
                value(&minutes),
                seconds.map(|s| value(&s)),
                lang,
            ),
            after,
        ));
    }
    if lang != Lang::Fr {
        return None;
    }
    // "12h30", "12 h 30", "12h", "12 h".
    let mut h = end;
    if chars.get(h).is_some_and(|c| is_space(*c)) {
        h += 1;
    }
    if !matches!(chars.get(h), Some('h' | 'H')) {
        return None;
    }
    let after_h = h + 1;
    let minutes_start =
        if chars.get(after_h).is_some_and(|c| is_space(*c)) && is_digit(chars, after_h + 1) {
            after_h + 1
        } else {
            after_h
        };
    if let Some((minutes, after)) = minutes_at(minutes_start)
        && !is_letter(chars, after)
    {
        return Some((clock(value(&hours), value(&minutes), None, lang), after));
    }
    if !boundary(chars, after_h) || is_digit(chars, after_h) {
        return None;
    }
    Some((clock(value(&hours), 0, None, lang), after_h))
}

/// Hours, minutes and seconds as said.
fn clock(hours: u64, minutes: u64, seconds: Option<u64>, lang: Lang) -> String {
    match lang {
        Lang::Fr => {
            let mut words = format!(
                "{} {}",
                cardinal(hours, lang, true),
                if hours >= 2 { "heures" } else { "heure" }
            );
            if let Some(seconds) = seconds {
                words.push_str(&format!(
                    " {} {}",
                    cardinal(minutes, lang, true),
                    if minutes >= 2 { "minutes" } else { "minute" }
                ));
                words.push_str(&format!(
                    " et {} {}",
                    cardinal(seconds, lang, true),
                    if seconds >= 2 { "secondes" } else { "seconde" }
                ));
            } else if minutes > 0 {
                words.push(' ');
                words.push_str(&cardinal(minutes, lang, true));
            }
            words
        }
        Lang::En => {
            let hour = cardinal(hours, lang, false);
            let mut words = match minutes {
                0 if seconds.is_none() && hours > 12 => format!("{hour} hundred"),
                0 if seconds.is_none() => format!("{hour} o'clock"),
                1..=9 => format!("{hour} oh {}", cardinal(minutes, lang, false)),
                _ => format!("{hour} {}", cardinal(minutes, lang, false)),
            };
            if let Some(seconds) = seconds {
                words.push_str(&format!(
                    " and {} {}",
                    cardinal(seconds, lang, false),
                    if seconds == 1 { "second" } else { "seconds" }
                ));
            }
            words
        }
    }
}

/// An ordinal's suffix after the digits `digits` ending at `at`.
fn ordinal(chars: &[char], at: usize, digits: &str, lang: Lang) -> Option<(String, usize)> {
    let suffixes: &[&str] = match lang {
        Lang::Fr => &[
            "ères", "èmes", "eres", "emes", "ère", "ème", "ers", "res", "ndes", "nds", "nde",
            "ere", "eme", "es", "er", "re", "nd", "e", "è", "ᵉʳ", "ʳᵉ", "ᵉ",
        ],
        Lang::En => &["st", "nd", "rd", "th", "ST", "ND", "RD", "TH"],
    };
    let number = value(digits);
    if number == u64::MAX || digits.starts_with('0') {
        return None;
    }
    for suffix in suffixes {
        let len = suffix.chars().count();
        let Some(written) = chars.get(at..at + len) else {
            continue;
        };
        if !written.iter().copied().eq(suffix.chars()) || !boundary(chars, at + len) {
            continue;
        }
        let words = match lang {
            Lang::Fr => {
                let plural = suffix.ends_with('s');
                let word = match *suffix {
                    // "1er", "1re": first only ("21e", not "21er").
                    "er" | "ers" | "ᵉʳ" if number == 1 => "premier".to_string(),
                    "re" | "res" | "ère" | "ères" | "ere" | "eres" | "ʳᵉ" if number == 1 => {
                        "première".to_string()
                    }
                    "nd" | "nds" if number == 2 => "second".to_string(),
                    "nde" | "ndes" if number == 2 => "seconde".to_string(),
                    "e" | "es" | "ème" | "èmes" | "eme" | "emes" | "è" | "ᵉ" => {
                        if number == 1 {
                            "premier".to_string()
                        } else {
                            ordinal_fr(&cardinal(number, lang, false))
                        }
                    }
                    _ => return None,
                };
                if plural { format!("{word}s") } else { word }
            }
            Lang::En => {
                let expected = match (number % 10, number % 100) {
                    (_, 11..=13) => "th",
                    (1, _) => "st",
                    (2, _) => "nd",
                    (3, _) => "rd",
                    _ => "th",
                };
                if !suffix.eq_ignore_ascii_case(expected) {
                    return None;
                }
                ordinal_en(&cardinal(number, lang, false))
            }
        };
        return Some((words, at + len));
    }
    None
}

/// A French cardinal's ordinal: "vingt et un" → "vingt et unième".
fn ordinal_fr(cardinal: &str) -> String {
    let (head, last) = match cardinal.rfind([' ', '-']) {
        Some(at) => cardinal.split_at(at + 1),
        None => ("", cardinal),
    };
    let last = match last {
        "cinq" => "cinquième".to_string(),
        "neuf" => "neuvième".to_string(),
        "cents" => "centième".to_string(),
        "vingts" => "vingtième".to_string(),
        word => format!("{}ième", word.strip_suffix('e').unwrap_or(word)),
    };
    format!("{head}{last}")
}

/// An English cardinal's ordinal: "twenty-one" → "twenty-first".
fn ordinal_en(cardinal: &str) -> String {
    let (head, last) = match cardinal.rfind([' ', '-']) {
        Some(at) => cardinal.split_at(at + 1),
        None => ("", cardinal),
    };
    let last = match last {
        "one" => "first".to_string(),
        "two" => "second".to_string(),
        "three" => "third".to_string(),
        "five" => "fifth".to_string(),
        "eight" => "eighth".to_string(),
        "nine" => "ninth".to_string(),
        "twelve" => "twelfth".to_string(),
        word if word.ends_with('y') => format!("{}ieth", &word[..word.len() - 1]),
        word => format!("{word}th"),
    };
    format!("{head}{last}")
}

/// Digits as a number; one with a leading zero ("007", a phone number) or
/// too long to be one is read digit by digit.
fn integer(digits: &str, lang: Lang, feminine: bool) -> String {
    if digits.len() > 15 || (digits.len() > 1 && digits.starts_with('0')) {
        return digit_by_digit(digits, lang);
    }
    cardinal(value(digits), lang, feminine)
}

fn digit_by_digit(digits: &str, lang: Lang) -> String {
    digits
        .chars()
        .filter_map(|c| c.to_digit(10))
        .map(|d| cardinal(d as u64, lang, false))
        .collect::<Vec<_>>()
        .join(" ")
}

const UNITS_FR: [&str; 17] = [
    "zéro", "un", "deux", "trois", "quatre", "cinq", "six", "sept", "huit", "neuf", "dix", "onze",
    "douze", "treize", "quatorze", "quinze", "seize",
];
const TENS_FR: [&str; 7] = [
    "",
    "dix",
    "vingt",
    "trente",
    "quarante",
    "cinquante",
    "soixante",
];
const UNITS_EN: [&str; 20] = [
    "zero",
    "one",
    "two",
    "three",
    "four",
    "five",
    "six",
    "seven",
    "eight",
    "nine",
    "ten",
    "eleven",
    "twelve",
    "thirteen",
    "fourteen",
    "fifteen",
    "sixteen",
    "seventeen",
    "eighteen",
    "nineteen",
];
const TENS_EN: [&str; 10] = [
    "", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety",
];

/// `n` in words; in French, `feminine` makes its last "un" "une" (une
/// heure, vingt et une secondes).
fn cardinal(n: u64, lang: Lang, feminine: bool) -> String {
    match lang {
        Lang::Fr => {
            let words = cardinal_fr(n);
            if feminine && (words == "un" || words.ends_with(" un") || words.ends_with("-un")) {
                format!("{words}e")
            } else {
                words
            }
        }
        Lang::En => cardinal_en(n),
    }
}

/// French below 100; `last` when nothing follows (quatre-vingts).
fn below_100_fr(n: u64, last: bool) -> String {
    match n {
        0..=16 => UNITS_FR[n as usize].to_string(),
        17..=19 => format!("dix-{}", UNITS_FR[n as usize - 10]),
        20..=69 => {
            let (tens, unit) = (n / 10, n % 10);
            match unit {
                0 => TENS_FR[tens as usize].to_string(),
                1 => format!("{} et un", TENS_FR[tens as usize]),
                _ => format!("{}-{}", TENS_FR[tens as usize], UNITS_FR[unit as usize]),
            }
        }
        70..=79 => match n {
            71 => "soixante et onze".to_string(),
            _ => format!("soixante-{}", below_100_fr(n - 60, true)),
        },
        80 => if last {
            "quatre-vingts"
        } else {
            "quatre-vingt"
        }
        .to_string(),
        _ => format!("quatre-vingt-{}", below_100_fr(n - 80, true)),
    }
}

/// French below 1000; `last` when nothing follows (deux cents).
fn below_1000_fr(n: u64, last: bool) -> String {
    let (hundreds, rest) = (n / 100, n % 100);
    let mut words = match hundreds {
        0 => String::new(),
        1 => "cent".to_string(),
        _ if rest == 0 && last => format!("{} cents", UNITS_FR[hundreds as usize]),
        _ => format!("{} cent", UNITS_FR[hundreds as usize]),
    };
    if rest > 0 || hundreds == 0 {
        if !words.is_empty() {
            words.push(' ');
        }
        words.push_str(&below_100_fr(rest, last));
    }
    words
}

fn cardinal_fr(n: u64) -> String {
    if n < 1000 {
        return below_1000_fr(n, true);
    }
    // Millions and above are nouns: "deux millions", "quatre-vingts
    // millions"; "mille" never takes an s, nor "un" before it.
    const SCALES: [(u64, &str, &str); 4] = [
        (1_000_000_000_000, "billion", "billions"),
        (1_000_000_000, "milliard", "milliards"),
        (1_000_000, "million", "millions"),
        (1_000, "mille", "mille"),
    ];
    let mut words: Vec<String> = Vec::new();
    let mut rest = n;
    for (scale, one, many) in SCALES {
        let count = rest / scale;
        rest %= scale;
        if count == 0 {
            continue;
        }
        if scale == 1_000 {
            if count == 1 {
                words.push("mille".into());
            } else {
                words.push(format!("{} mille", below_1000_fr(count, false)));
            }
        } else {
            let count_words = if count >= 1000 {
                cardinal_fr(count)
            } else {
                below_1000_fr(count, true)
            };
            words.push(format!(
                "{count_words} {}",
                if count == 1 { one } else { many }
            ));
        }
    }
    if rest > 0 {
        words.push(below_1000_fr(rest, true));
    }
    words.join(" ")
}

fn cardinal_en(n: u64) -> String {
    fn below_1000(n: u64) -> String {
        let (hundreds, rest) = (n / 100, n % 100);
        let mut words = Vec::new();
        if hundreds > 0 {
            words.push(format!("{} hundred", UNITS_EN[hundreds as usize]));
        }
        if rest > 0 || hundreds == 0 {
            words.push(match rest {
                0..=19 => UNITS_EN[rest as usize].to_string(),
                _ if rest % 10 == 0 => TENS_EN[rest as usize / 10].to_string(),
                _ => format!(
                    "{}-{}",
                    TENS_EN[rest as usize / 10],
                    UNITS_EN[rest as usize % 10]
                ),
            });
        }
        words.join(" ")
    }
    if n < 1000 {
        return below_1000(n);
    }
    const SCALES: [(u64, &str); 4] = [
        (1_000_000_000_000, "trillion"),
        (1_000_000_000, "billion"),
        (1_000_000, "million"),
        (1_000, "thousand"),
    ];
    let mut words = Vec::new();
    let mut rest = n;
    for (scale, name) in SCALES {
        let count = rest / scale;
        rest %= scale;
        if count > 0 {
            let count = if count >= 1000 {
                cardinal_en(count)
            } else {
                below_1000(count)
            };
            words.push(format!("{count} {name}"));
        }
    }
    if rest > 0 {
        words.push(below_1000(rest));
    }
    words.join(" ")
}

/// A unit read after a number: its singular and plural, and whether a
/// French "un" before it is "une".
struct Measure {
    singular: &'static str,
    plural: &'static str,
    feminine: bool,
}

#[derive(Clone, Copy)]
enum Currency {
    Euro,
    Dollar,
    Pound,
}

enum Unit {
    Money(Currency),
    Measure(Measure),
}

fn currency_sign(c: char) -> Option<Currency> {
    match c {
        '€' => Some(Currency::Euro),
        '$' => Some(Currency::Dollar),
        '£' => Some(Currency::Pound),
        _ => None,
    }
}

/// The units written after a number, longest first where one starts
/// another: the written form, French's singular and plural (and gender),
/// English's.
#[allow(clippy::type_complexity)]
const UNITS: &[(&str, (&str, &str, bool), (&str, &str))] = &[
    (
        "km/h",
        ("kilomètre par heure", "kilomètres par heure", false),
        ("kilometer per hour", "kilometers per hour"),
    ),
    (
        "Mo/s",
        ("mégaoctet par seconde", "mégaoctets par seconde", false),
        ("megabyte per second", "megabytes per second"),
    ),
    (
        "Go/s",
        ("gigaoctet par seconde", "gigaoctets par seconde", false),
        ("gigabyte per second", "gigabytes per second"),
    ),
    (
        "MB/s",
        ("mégaoctet par seconde", "mégaoctets par seconde", false),
        ("megabyte per second", "megabytes per second"),
    ),
    (
        "GB/s",
        ("gigaoctet par seconde", "gigaoctets par seconde", false),
        ("gigabyte per second", "gigabytes per second"),
    ),
    (
        "Mb/s",
        ("mégabit par seconde", "mégabits par seconde", false),
        ("megabit per second", "megabits per second"),
    ),
    (
        "Gb/s",
        ("gigabit par seconde", "gigabits par seconde", false),
        ("gigabit per second", "gigabits per second"),
    ),
    (
        "Mbps",
        ("mégabit par seconde", "mégabits par seconde", false),
        ("megabit per second", "megabits per second"),
    ),
    (
        "Gbps",
        ("gigabit par seconde", "gigabits par seconde", false),
        ("gigabit per second", "gigabits per second"),
    ),
    (
        "°C",
        ("degré Celsius", "degrés Celsius", false),
        ("degree Celsius", "degrees Celsius"),
    ),
    (
        "°F",
        ("degré Fahrenheit", "degrés Fahrenheit", false),
        ("degree Fahrenheit", "degrees Fahrenheit"),
    ),
    ("°", ("degré", "degrés", false), ("degree", "degrees")),
    (
        "kWh",
        ("kilowattheure", "kilowattheures", false),
        ("kilowatt-hour", "kilowatt-hours"),
    ),
    (
        "mAh",
        ("milliampère-heure", "milliampères-heures", false),
        ("milliamp-hour", "milliamp-hours"),
    ),
    (
        "GiB",
        ("gibioctet", "gibioctets", false),
        ("gibibyte", "gibibytes"),
    ),
    (
        "MiB",
        ("mébioctet", "mébioctets", false),
        ("mebibyte", "mebibytes"),
    ),
    (
        "KiB",
        ("kibioctet", "kibioctets", false),
        ("kibibyte", "kibibytes"),
    ),
    (
        "TiB",
        ("tébioctet", "tébioctets", false),
        ("tebibyte", "tebibytes"),
    ),
    (
        "Go",
        ("gigaoctet", "gigaoctets", false),
        ("gigabyte", "gigabytes"),
    ),
    (
        "Mo",
        ("mégaoctet", "mégaoctets", false),
        ("megabyte", "megabytes"),
    ),
    (
        "Ko",
        ("kilooctet", "kilooctets", false),
        ("kilobyte", "kilobytes"),
    ),
    (
        "ko",
        ("kilooctet", "kilooctets", false),
        ("kilobyte", "kilobytes"),
    ),
    (
        "To",
        ("téraoctet", "téraoctets", false),
        ("terabyte", "terabytes"),
    ),
    (
        "GB",
        ("gigaoctet", "gigaoctets", false),
        ("gigabyte", "gigabytes"),
    ),
    (
        "MB",
        ("mégaoctet", "mégaoctets", false),
        ("megabyte", "megabytes"),
    ),
    (
        "KB",
        ("kilooctet", "kilooctets", false),
        ("kilobyte", "kilobytes"),
    ),
    (
        "kB",
        ("kilooctet", "kilooctets", false),
        ("kilobyte", "kilobytes"),
    ),
    (
        "TB",
        ("téraoctet", "téraoctets", false),
        ("terabyte", "terabytes"),
    ),
    (
        "GHz",
        ("gigahertz", "gigahertz", false),
        ("gigahertz", "gigahertz"),
    ),
    (
        "MHz",
        ("mégahertz", "mégahertz", false),
        ("megahertz", "megahertz"),
    ),
    (
        "kHz",
        ("kilohertz", "kilohertz", false),
        ("kilohertz", "kilohertz"),
    ),
    ("Hz", ("hertz", "hertz", false), ("hertz", "hertz")),
    (
        "kW",
        ("kilowatt", "kilowatts", false),
        ("kilowatt", "kilowatts"),
    ),
    (
        "km",
        ("kilomètre", "kilomètres", false),
        ("kilometer", "kilometers"),
    ),
    (
        "cm",
        ("centimètre", "centimètres", false),
        ("centimeter", "centimeters"),
    ),
    (
        "mm",
        ("millimètre", "millimètres", false),
        ("millimeter", "millimeters"),
    ),
    ("kg", ("kilo", "kilos", false), ("kilogram", "kilograms")),
    (
        "mg",
        ("milligramme", "milligrammes", false),
        ("milligram", "milligrams"),
    ),
    (
        "ml",
        ("millilitre", "millilitres", false),
        ("milliliter", "milliliters"),
    ),
    (
        "ms",
        ("milliseconde", "millisecondes", true),
        ("millisecond", "milliseconds"),
    ),
    (
        "µs",
        ("microseconde", "microsecondes", true),
        ("microsecond", "microseconds"),
    ),
    (
        "ns",
        ("nanoseconde", "nanosecondes", true),
        ("nanosecond", "nanoseconds"),
    ),
    ("min", ("minute", "minutes", true), ("minute", "minutes")),
    ("px", ("pixel", "pixels", false), ("pixel", "pixels")),
    (
        "fps",
        ("image par seconde", "images par seconde", true),
        ("frame per second", "frames per second"),
    ),
    ("s", ("seconde", "secondes", true), ("second", "seconds")),
    ("h", ("heure", "heures", true), ("hour", "hours")),
    ("m", ("mètre", "mètres", false), ("meter", "meters")),
    ("g", ("gramme", "grammes", false), ("gram", "grams")),
    ("W", ("watt", "watts", false), ("watt", "watts")),
    ("V", ("volt", "volts", false), ("volt", "volts")),
];

/// A unit or a currency after a number ending at `at` (after a space, or
/// none), and where it ends.
fn unit_after(chars: &[char], at: usize, lang: Lang) -> Option<(Unit, usize)> {
    let start = if chars.get(at).is_some_and(|c| is_space(*c)) {
        at + 1
    } else {
        at
    };
    if let Some(currency) = chars.get(start).copied().and_then(currency_sign)
        && boundary(chars, start + 1)
    {
        return Some((Unit::Money(currency), start + 1));
    }
    for (written, fr, en) in UNITS {
        let len = written.chars().count();
        let Some(found) = chars.get(start..start + len) else {
            continue;
        };
        if !found.iter().copied().eq(written.chars()) || !boundary(chars, start + len) {
            continue;
        }
        // "5 m" and "5 s" alone, not "5 m'a": boundary() refuses the
        // apostrophe already; a single letter also needs no dot after it
        // starting a word ("5 h. Puis").
        let measure = match lang {
            Lang::Fr => Measure {
                singular: fr.0,
                plural: fr.1,
                feminine: fr.2,
            },
            Lang::En => Measure {
                singular: en.0,
                plural: en.1,
                feminine: false,
            },
        };
        return Some((Unit::Measure(measure), start + len));
    }
    None
}

/// An amount of money: "5,50 €" → "cinq euros cinquante", "$3.50" →
/// "three dollars and fifty cents".
fn money(amount: &Number, currency: Currency, lang: Lang) -> String {
    let (one, many) = match (currency, lang) {
        (Currency::Euro, _) => ("euro", "euros"),
        (Currency::Dollar, _) => ("dollar", "dollars"),
        (Currency::Pound, Lang::Fr) => ("livre", "livres"),
        (Currency::Pound, Lang::En) => ("pound", "pounds"),
    };
    let feminine = matches!((currency, lang), (Currency::Pound, Lang::Fr));
    match &amount.fraction {
        Some(cents) if cents.len() == 2 => {
            let whole = Number {
                integer: amount.integer.clone(),
                fraction: None,
            };
            let units = format!(
                "{} {}",
                whole.words(lang, feminine),
                if whole.plural(lang) { many } else { one }
            );
            let cents = value(cents);
            if cents == 0 {
                return units;
            }
            match lang {
                Lang::Fr => format!("{units} {}", cardinal(cents, lang, false)),
                Lang::En => format!(
                    "{units} and {} {}",
                    cardinal(cents, lang, false),
                    match (currency, cents) {
                        (Currency::Pound, 1) => "penny",
                        (Currency::Pound, _) => "pence",
                        (_, 1) => "cent",
                        _ => "cents",
                    }
                ),
            }
        }
        _ => format!(
            "{} {}",
            amount.words(lang, feminine),
            if amount.plural(lang) { many } else { one }
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    /// The cases of contract/vectors/pocket-spoken-numbers.json, each a
    /// call of `spoken.spell_out` with a text and a language.
    #[test]
    fn spoken_vectors() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../contract/vectors/pocket-spoken-numbers.json");
        let raw = std::fs::read_to_string(&path)
            .unwrap_or_else(|err| panic!("{}: {err}", path.display()));
        let file: Value = serde_json::from_str(&raw).unwrap();
        let mut failures = Vec::new();
        let mut calls = 0;
        for case in file["cases"].as_array().unwrap() {
            for call in case["calls"].as_array().unwrap() {
                assert_eq!(call["fn"], "spoken.spell_out", "{}", case["name"]);
                let text = call["args"][0].as_str().unwrap();
                let language = call["args"][1].as_str().unwrap();
                let got = spell_out(text, language);
                calls += 1;
                if got != call["result"].as_str().unwrap() {
                    failures.push(format!(
                        "{} ({language}): {text:?}\n   got {got:?}\n  want {}",
                        case["name"], call["result"]
                    ));
                }
            }
        }
        assert!(calls > 50);
        assert!(failures.is_empty(), "\n{}", failures.join("\n"));
    }
}
