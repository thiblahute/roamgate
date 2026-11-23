//! node:util `parseArgs`, strict, positionals allowed, as the CLI's
//! commands use it (parseCommandArgs): its options and its error texts.

use std::collections::HashMap;

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum Kind {
    Boolean,
    Text,
    Many,
}

pub(crate) struct Spec {
    pub(crate) name: &'static str,
    pub(crate) kind: Kind,
    pub(crate) short: Option<char>,
}

pub(crate) const fn flag(name: &'static str) -> Spec {
    Spec {
        name,
        kind: Kind::Boolean,
        short: None,
    }
}

pub(crate) const fn text(name: &'static str) -> Spec {
    Spec {
        name,
        kind: Kind::Text,
        short: None,
    }
}

pub(crate) const fn many(name: &'static str) -> Spec {
    Spec {
        name,
        kind: Kind::Many,
        short: None,
    }
}

impl Spec {
    /// With a one-letter alias (`-y`).
    pub(crate) const fn short(self, letter: char) -> Spec {
        Spec {
            short: Some(letter),
            ..self
        }
    }
}

#[derive(Default)]
pub(crate) struct Parsed {
    flags: HashMap<&'static str, bool>,
    texts: HashMap<&'static str, String>,
    lists: HashMap<&'static str, Vec<String>>,
    pub(crate) positionals: Vec<String>,
}

impl Parsed {
    pub(crate) fn flag(&self, name: &str) -> bool {
        self.flags.get(name).copied().unwrap_or(false)
    }

    pub(crate) fn text(&self, name: &str) -> Option<String> {
        self.texts.get(name).cloned()
    }

    pub(crate) fn list(&self, name: &str) -> Option<Vec<String>> {
        self.lists.get(name).cloned()
    }
}

fn unknown(option: &str) -> String {
    format!(
        "Unknown option '{option}'. To specify a positional argument starting with a '-', place it at the end of the command after '--', as in '-- \"{option}\""
    )
}

/// node:util parseArgs, strict, positionals allowed (parseCommandArgs).
pub(crate) fn parse_args(
    args: &[String],
    specs: &[Spec],
    max_positionals: usize,
) -> Result<Parsed, String> {
    let mut parsed = Parsed::default();
    let store = |spec: &Spec, value: Option<String>, parsed: &mut Parsed| match spec.kind {
        Kind::Boolean => {
            parsed.flags.insert(spec.name, true);
        }
        Kind::Text => {
            parsed.texts.insert(spec.name, value.unwrap_or_default());
        }
        Kind::Many => parsed
            .lists
            .entry(spec.name)
            .or_default()
            .push(value.unwrap_or_default()),
    };
    let mut index = 0;
    while index < args.len() {
        let arg = &args[index];
        index += 1;
        if arg == "--" {
            parsed.positionals.extend(args[index..].iter().cloned());
            break;
        }
        if let Some(long) = arg.strip_prefix("--") {
            let (name, inline) = match long.split_once('=') {
                Some((name, value)) => (name, Some(value.to_owned())),
                None => (long, None),
            };
            let Some(spec) = specs.iter().find(|spec| spec.name == name) else {
                return Err(unknown(&format!("--{name}")));
            };
            if spec.kind == Kind::Boolean {
                if inline.is_some() {
                    return Err(format!("Option '--{name}' does not take an argument"));
                }
                store(spec, None, &mut parsed);
                continue;
            }
            let value = match inline {
                Some(value) => value,
                None => {
                    let Some(next) = args.get(index) else {
                        return Err(format!("Option '--{name} <value>' argument missing"));
                    };
                    if next.starts_with('-') {
                        return Err(format!(
                            "Option '--{name}' argument is ambiguous.\nDid you forget to specify the option argument for '--{name}'?\nTo specify an option argument starting with a dash use '--{name}=-XYZ'."
                        ));
                    }
                    index += 1;
                    next.clone()
                }
            };
            store(spec, Some(value), &mut parsed);
            continue;
        }
        if let Some(short) = arg.strip_prefix('-').filter(|rest| !rest.is_empty()) {
            let letter = short.chars().next().unwrap();
            let Some(spec) = specs.iter().find(|spec| spec.short == Some(letter)) else {
                return Err(unknown(&if short.chars().count() == 1 {
                    format!("-{letter}")
                } else {
                    letter.to_string()
                }));
            };
            if spec.kind == Kind::Boolean {
                store(spec, None, &mut parsed);
                continue;
            }
            let rest = &short[letter.len_utf8()..];
            let value = if !rest.is_empty() {
                rest.to_owned()
            } else {
                let Some(next) = args.get(index) else {
                    return Err(format!(
                        "Option '-{letter}, --{} <value>' argument missing",
                        spec.name
                    ));
                };
                if next.starts_with('-') {
                    return Err(format!(
                        "Option '-{letter}' argument is ambiguous.\nDid you forget to specify the option argument for '-{letter}'?\nTo specify an option argument starting with a dash use '--{}=-XYZ' or '-{letter}-XYZ'.",
                        spec.name
                    ));
                }
                index += 1;
                next.clone()
            };
            store(spec, Some(value), &mut parsed);
            continue;
        }
        parsed.positionals.push(arg.clone());
    }
    if parsed.positionals.len() > max_positionals {
        return Err(format!(
            "unexpected argument: {}",
            parsed.positionals[max_positionals]
        ));
    }
    Ok(parsed)
}
