//! The management commands' shared conventions (cli/command.ts): strict
//! flags as Bun's `util.parseArgs` reads them, with its messages, `--help`
//! detection, and the error convention of runCli (a failure is `roamgate
//! <command>: <reason>` and exit 1, a usage error adds `Run \`roamgate
//! <command> --help\` for usage.` and exits 2).

use std::collections::BTreeMap;

use serde_json::Value;

use crate::output::Printed;

pub const EXIT_OK: i32 = 0;
pub const EXIT_FAILURE: i32 = 1;
pub const EXIT_USAGE: i32 = 2;

/// Why a command stopped: an `Error` (exit 1) or a `UsageError` (exit 2).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Failure {
    Failed(String),
    Usage(String),
}

impl Failure {
    pub fn message(&self) -> &str {
        match self {
            Self::Failed(message) | Self::Usage(message) => message,
        }
    }

    pub fn failed(message: impl std::fmt::Display) -> Self {
        Self::Failed(message.to_string())
    }

    pub fn usage(message: impl std::fmt::Display) -> Self {
        Self::Usage(message.to_string())
    }
}

/// `wantsHelp`: `--help`, `-h` or a leading `help` word.
pub fn wants_help(args: &[String]) -> bool {
    args.first().map(String::as_str) == Some("help")
        || args.iter().any(|arg| arg == "--help" || arg == "-h")
}

/// runCli's catch: the failure's lines and exit code.
pub fn finish(command: &str, mut printed: Printed, result: Result<i32, Failure>) -> Printed {
    match result {
        Ok(code) => printed.exit(code),
        Err(failure) => {
            report_failure(command, &failure, &mut |line| printed.error(line));
            printed.exit(failure_code(&failure))
        }
    }
}

/// The lines runCli prints for a failure.
pub fn report_failure(command: &str, failure: &Failure, error: &mut dyn FnMut(&str)) {
    error(&format!("roamgate {command}: {}", failure.message()));
    if matches!(failure, Failure::Usage(_)) {
        error(&format!("Run `roamgate {command} --help` for usage."));
    }
}

pub fn failure_code(failure: &Failure) -> i32 {
    match failure {
        Failure::Failed(_) => EXIT_FAILURE,
        Failure::Usage(_) => EXIT_USAGE,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Boolean,
    String,
    /// A string option given any number of times (`multiple: true`).
    Many,
}

impl Kind {
    fn takes_value(self) -> bool {
        matches!(self, Kind::String | Kind::Many)
    }
}

/// An option of `parseArgs`' `options`.
#[derive(Debug, Clone, Copy)]
pub struct Opt {
    pub name: &'static str,
    pub kind: Kind,
    pub short: Option<char>,
}

impl Opt {
    pub const fn flag(name: &'static str) -> Self {
        Self {
            name,
            kind: Kind::Boolean,
            short: None,
        }
    }

    pub const fn string(name: &'static str) -> Self {
        Self {
            name,
            kind: Kind::String,
            short: None,
        }
    }

    pub const fn many(name: &'static str) -> Self {
        Self {
            name,
            kind: Kind::Many,
            short: None,
        }
    }

    pub const fn short(mut self, letter: char) -> Self {
        self.short = Some(letter);
        self
    }
}

/// `parseArgs`' result: the last value of each option given, and the
/// positionals.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Parsed {
    pub values: BTreeMap<String, Option<String>>,
    /// Every value of a [`Kind::Many`] option, in order.
    pub lists: BTreeMap<String, Vec<String>>,
    pub positionals: Vec<String>,
}

impl Parsed {
    /// A boolean option given.
    pub fn flag(&self, name: &str) -> bool {
        self.values.contains_key(name)
    }

    /// A string option's value.
    pub fn string(&self, name: &str) -> Option<&str> {
        self.values.get(name).and_then(|value| value.as_deref())
    }

    /// A string option's value, owned.
    pub fn text(&self, name: &str) -> Option<String> {
        self.string(name).map(str::to_owned)
    }

    /// Every value of a [`Kind::Many`] option, None when it was not given.
    pub fn list(&self, name: &str) -> Option<Vec<String>> {
        self.lists.get(name).cloned()
    }
}

struct Token {
    name: String,
    raw: String,
    value: Option<String>,
    inline: bool,
}

fn long_for_short(letter: char, options: &[Opt]) -> String {
    options
        .iter()
        .find(|option| option.short == Some(letter))
        .map(|option| option.name.to_owned())
        .unwrap_or_else(|| letter.to_string())
}

fn kind_of(name: &str, options: &[Opt]) -> Option<Kind> {
    options
        .iter()
        .find(|option| option.name == name)
        .map(|option| option.kind)
}

/// `util.parseArgs({ args, options, strict: true, allowPositionals: true })`
/// as Bun runs it, its errors as usage errors.
pub fn parse_args(args: &[String], options: &[Opt]) -> Result<Parsed, Failure> {
    let mut parsed = Parsed::default();
    let mut tokens: Vec<Token> = Vec::new();
    let mut rest: std::collections::VecDeque<String> = args.iter().cloned().collect();
    let mut terminated = false;
    while let Some(arg) = rest.pop_front() {
        let chars: Vec<char> = arg.chars().collect();
        if terminated {
            parsed.positionals.push(arg);
            continue;
        }
        if arg == "--" {
            terminated = true;
            continue;
        }
        let dash = chars.first() == Some(&'-');
        let double = arg.starts_with("--");
        if chars.len() == 2 && dash && chars[1] != '-' {
            // A lone short option.
            let name = long_for_short(chars[1], options);
            let value = if kind_of(&name, options).is_some_and(Kind::takes_value) {
                rest.pop_front()
            } else {
                None
            };
            tokens.push(Token {
                name,
                raw: arg.clone(),
                value,
                inline: false,
            });
            continue;
        }
        if chars.len() > 2 && dash && chars[1] != '-' {
            let first = long_for_short(chars[1], options);
            if !kind_of(&first, options).is_some_and(Kind::takes_value) {
                // A group of short options: Bun names its letters bare.
                for (index, letter) in chars.iter().enumerate().skip(1) {
                    let name = long_for_short(*letter, options);
                    if kind_of(&name, options).is_some_and(Kind::takes_value) {
                        let tail: String = chars[index + 1..].iter().collect();
                        let (value, inline) = if tail.is_empty() {
                            (rest.pop_front(), false)
                        } else {
                            (Some(tail), true)
                        };
                        tokens.push(Token {
                            name,
                            raw: letter.to_string(),
                            value,
                            inline,
                        });
                        break;
                    }
                    tokens.push(Token {
                        name,
                        raw: letter.to_string(),
                        value: None,
                        inline: false,
                    });
                }
                continue;
            }
            // A short option and its value.
            tokens.push(Token {
                name: first,
                raw: format!("-{}", chars[1]),
                value: Some(chars[2..].iter().collect()),
                inline: true,
            });
            continue;
        }
        if chars.len() > 2 && double {
            match arg
                .char_indices()
                .find(|(index, character)| *character == '=' && *index >= 3)
                .map(|(index, _)| index)
            {
                None => {
                    let name = arg[2..].to_owned();
                    let value = if kind_of(&name, options).is_some_and(Kind::takes_value) {
                        rest.pop_front()
                    } else {
                        None
                    };
                    tokens.push(Token {
                        name,
                        raw: arg.clone(),
                        value,
                        inline: false,
                    });
                }
                Some(equals) => {
                    let name = arg[2..equals].to_owned();
                    tokens.push(Token {
                        raw: format!("--{name}"),
                        name,
                        value: Some(arg[equals + 1..].to_owned()),
                        inline: true,
                    });
                }
            }
            continue;
        }
        parsed.positionals.push(arg);
    }
    for token in tokens {
        let Some(option) = options.iter().find(|option| option.name == token.name) else {
            return Err(Failure::Usage(format!(
                "Unknown option '{}'. To specify a positional argument starting with a '-', place it at the end of the command after '--', as in '-- {}",
                token.raw,
                Value::String(token.raw.clone())
            )));
        };
        let short = option
            .short
            .map(|letter| format!("-{letter}, "))
            .unwrap_or_default();
        match option.kind {
            Kind::String | Kind::Many if token.value.is_none() => {
                return Err(Failure::Usage(format!(
                    "Option '{short}--{} <value>' argument missing",
                    option.name
                )));
            }
            Kind::Boolean if token.value.is_some() => {
                return Err(Failure::Usage(format!(
                    "Option '{short}--{}' does not take an argument",
                    option.name
                )));
            }
            _ => {}
        }
        if let Some(value) = &token.value
            && !token.inline
            && value.chars().count() > 1
            && value.starts_with('-')
        {
            let example = if token.raw.starts_with("--") {
                format!("'{}=-XYZ'", token.raw)
            } else {
                format!("'--{}=-XYZ' or '{}-XYZ'", option.name, token.raw)
            };
            return Err(Failure::Usage(format!(
                "Option '{raw}' argument is ambiguous.\nDid you forget to specify the option argument for '{raw}'?\nTo specify an option argument starting with a dash use {example}.",
                raw = token.raw
            )));
        }
        if option.kind == Kind::Many {
            parsed
                .lists
                .entry(token.name.clone())
                .or_default()
                .push(token.value.clone().unwrap_or_default());
        }
        parsed.values.insert(token.name, token.value);
    }
    Ok(parsed)
}

/// `parseCommandArgs`: [`parse_args`], then at most `max_positionals`.
pub fn parse_command_args(
    args: &[String],
    options: &[Opt],
    max_positionals: usize,
) -> Result<Parsed, Failure> {
    let parsed = parse_args(args, options)?;
    if let Some(extra) = parsed.positionals.get(max_positionals) {
        return Err(Failure::Usage(format!("unexpected argument: {extra}")));
    }
    Ok(parsed)
}

/// Boolean flags only, no positionals: the names given.
pub fn parse_flags(args: &[String], known: &[&'static str]) -> Result<Vec<String>, Failure> {
    let options: Vec<Opt> = known.iter().map(|name| Opt::flag(name)).collect();
    Ok(parse_command_args(args, &options, 0)?
        .values
        .into_keys()
        .collect())
}

/// `JSON.stringify(value, null, 2)`.
pub fn pretty_json(value: &Value) -> String {
    serde_json::to_string_pretty(value).unwrap_or_default()
}

/// `displayPath`: a path under the home as `~/...`, except on Windows.
pub fn display_path(path: &str, platform: &str, home: &str) -> String {
    if platform == "win32" {
        return path.to_owned();
    }
    if path == home || path.starts_with(&format!("{home}/")) {
        format!("~{}", &path[home.len()..])
    } else {
        path.to_owned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|arg| (*arg).to_owned()).collect()
    }

    const LOGS: &[Opt] = &[
        Opt::flag("follow").short('f'),
        Opt::string("lines").short('n'),
        Opt::flag("json"),
    ];

    fn run(list: &[&str]) -> Result<Parsed, String> {
        parse_args(&args(list), LOGS).map_err(|failure| failure.message().to_owned())
    }

    /// Each case was run through Bun's `util.parseArgs` with these options.
    #[test]
    fn reads_flags_as_buns_parse_args_does() {
        let unknown = |raw: &str| {
            format!(
                "Unknown option '{raw}'. To specify a positional argument starting with a '-', place it at the end of the command after '--', as in '-- \"{raw}\""
            )
        };
        assert_eq!(
            run(&["--lines"]).unwrap_err(),
            "Option '-n, --lines <value>' argument missing"
        );
        assert_eq!(
            run(&["-n"]).unwrap_err(),
            "Option '-n, --lines <value>' argument missing"
        );
        assert_eq!(
            run(&["--lines", "-5"]).unwrap_err(),
            "Option '--lines' argument is ambiguous.\nDid you forget to specify the option argument for '--lines'?\nTo specify an option argument starting with a dash use '--lines=-XYZ'."
        );
        assert_eq!(
            run(&["-n", "-5"]).unwrap_err(),
            "Option '-n' argument is ambiguous.\nDid you forget to specify the option argument for '-n'?\nTo specify an option argument starting with a dash use '--lines=-XYZ' or '-n-XYZ'."
        );
        assert_eq!(run(&["-x"]).unwrap_err(), unknown("-x"));
        assert_eq!(run(&["-fx"]).unwrap_err(), unknown("x"));
        assert_eq!(run(&["-xf"]).unwrap_err(), unknown("x"));
        assert_eq!(run(&["-f=1"]).unwrap_err(), unknown("="));
        assert_eq!(run(&["--nope"]).unwrap_err(), unknown("--nope"));
        assert_eq!(run(&["--=x"]).unwrap_err(), unknown("--=x"));
        assert_eq!(
            run(&["--follow=1"]).unwrap_err(),
            "Option '-f, --follow' does not take an argument"
        );
        assert_eq!(
            run(&["--json=1"]).unwrap_err(),
            "Option '--json' does not take an argument"
        );
        assert_eq!(
            run(&["-fn"]).unwrap_err(),
            "Option '-n, --lines <value>' argument missing"
        );
        let ok = |list: &[&str], values: &[(&str, Option<&str>)], positionals: &[&str]| {
            let parsed = run(list).unwrap();
            let want: BTreeMap<String, Option<String>> = values
                .iter()
                .map(|(name, value)| ((*name).to_owned(), value.map(str::to_owned)))
                .collect();
            assert_eq!(parsed.values, want, "{list:?}");
            assert_eq!(parsed.positionals, args(positionals), "{list:?}");
        };
        ok(
            &["-fn", "3"],
            &[("follow", None), ("lines", Some("3"))],
            &[],
        );
        ok(&["-n3"], &[("lines", Some("3"))], &[]);
        ok(&["-nf"], &[("lines", Some("f"))], &[]);
        ok(&["-ff"], &[("follow", None)], &[]);
        ok(&["-fnf"], &[("follow", None), ("lines", Some("f"))], &[]);
        ok(&["-n=3"], &[("lines", Some("=3"))], &[]);
        ok(&["-"], &[], &["-"]);
        ok(&["--lines=-5"], &[("lines", Some("-5"))], &[]);
        ok(&["-n-5"], &[("lines", Some("-5"))], &[]);
        ok(&["--", "--x"], &[], &["--x"]);
        ok(
            &["--lines", "a", "--lines", "b"],
            &[("lines", Some("b"))],
            &[],
        );
        ok(&["--lines", "-"], &[("lines", Some("-"))], &[]);
        ok(&["a", "--json"], &[("json", None)], &["a"]);
        assert_eq!(
            parse_command_args(&args(&["a", "b"]), LOGS, 1),
            Err(Failure::Usage("unexpected argument: b".into()))
        );
    }

    #[test]
    fn shows_home_paths_with_a_tilde_except_on_windows() {
        assert_eq!(display_path("/h/me/x", "linux", "/h/me"), "~/x");
        assert_eq!(display_path("/h/me", "darwin", "/h/me"), "~");
        assert_eq!(display_path("/h/men/x", "linux", "/h/me"), "/h/men/x");
        assert_eq!(display_path("/h/me/x", "win32", "/h/me"), "/h/me/x");
    }
}
