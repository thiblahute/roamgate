//! The launchd service environment (config/launchd-environment.ts): the
//! non-executable subset of a shell environment file, resolved without
//! sourcing it, so install never runs what the file would run.

use std::collections::BTreeMap;

fn shell_special(name: &str) -> bool {
    regex::Regex::new(r"^(?:BASH.*|COMP.*|HIST.*|READLINE.*|ENV|IFS|SHELLOPTS|UID|EUID|PPID|SHLVL|RANDOM|SRANDOM|SECONDS|LINENO|OPTIND|OPTARG|GROUPS|DIRSTACK|FUNCNAME|PIPESTATUS|COPROC|MAPFILE|EPOCHREALTIME|EPOCHSECONDS|HOSTNAME|HOSTTYPE|MACHTYPE|OSTYPE|REPLY|_)$")
        .unwrap()
        .is_match(name)
}

/// The non-executable subset of a launchd shell environment file, never
/// sourced: `NAME=value` with quotes, escapes and `$NAME`/`${NAME}` of
/// names defined before (HOME given).
pub fn resolve_launchd_environment(
    contents: &str,
    path: &str,
    home: &str,
) -> Result<BTreeMap<String, String>, String> {
    let chars: Vec<char> = contents.chars().collect();
    let mut values: BTreeMap<String, String> = BTreeMap::new();
    values.insert("HOME".into(), home.to_owned());
    let mut offset = 0usize;
    let fail = |offset: usize, reason: &str| -> String {
        let line = chars[..offset.min(chars.len())]
            .iter()
            .filter(|character| **character == '\n')
            .count()
            + 1;
        format!("invalid launchd environment at {path}:{line}: {reason}")
    };
    if contents.contains('\0') {
        return Err(fail(0, "NUL characters are not supported"));
    }
    let at = |offset: usize| chars.get(offset).copied();
    let starts_with = |offset: usize, text: &str| {
        text.chars()
            .enumerate()
            .all(|(index, character)| at(offset + index) == Some(character))
    };
    let space = |offset: &mut usize| {
        while matches!(at(*offset), Some(' ' | '\t')) {
            *offset += 1;
        }
    };
    let name_at = |offset: usize| -> Option<String> {
        let first = at(offset)?;
        if !(first.is_ascii_alphabetic() || first == '_') {
            return None;
        }
        let mut name = String::new();
        let mut index = offset;
        while let Some(character) = at(index) {
            if character.is_ascii_alphanumeric() || character == '_' {
                name.push(character);
                index += 1;
            } else {
                break;
            }
        }
        Some(name)
    };
    while offset < chars.len() {
        space(&mut offset);
        if at(offset) == Some('#') {
            while offset < chars.len() && chars[offset] != '\n' {
                offset += 1;
            }
        }
        if at(offset) == Some('\n') {
            offset += 1;
            continue;
        }
        if offset == chars.len() {
            break;
        }
        if starts_with(offset, "export") && matches!(at(offset + 6), Some(' ' | '\t')) {
            offset += 6;
            space(&mut offset);
        }
        let Some(name) =
            name_at(offset).filter(|name| at(offset + name.chars().count()) == Some('='))
        else {
            return Err(fail(offset, "expected one NAME=value assignment per line"));
        };
        if shell_special(&name) {
            return Err(fail(
                offset,
                "shell-special variable assignments are not supported",
            ));
        }
        offset += name.chars().count() + 1;
        let mut value = String::new();
        let mut quote: Option<char> = None;
        while offset < chars.len() {
            let character = chars[offset];
            if quote == Some('\'') {
                offset += 1;
                if character == '\'' {
                    quote = None;
                } else {
                    value.push(character);
                }
                continue;
            }
            if Some(character) == quote {
                quote = None;
                offset += 1;
                continue;
            }
            if quote.is_none() {
                if matches!(character, ' ' | '\t' | '\n') {
                    break;
                }
                if character == '\'' || character == '"' {
                    quote = Some(character);
                    offset += 1;
                    continue;
                }
                if ";&|<>()~".contains(character) {
                    return Err(fail(
                        offset,
                        "shell operators and unquoted tilde expansion are not supported",
                    ));
                }
            }
            if character == '`' {
                return Err(fail(offset, "command substitution is not supported"));
            }
            if character == '$' {
                // expandVariable
                let quoted = quote == Some('"');
                offset += 1;
                if starts_with(offset, "\\\n") {
                    return Err(fail(
                        offset,
                        "line continuations inside variable references are not supported",
                    ));
                }
                if !quoted && matches!(at(offset), Some('\'' | '"')) {
                    return Err(fail(offset, "shell-specific quoting is not supported"));
                }
                let braced = at(offset) == Some('{');
                if braced {
                    offset += 1;
                }
                let Some(reference) = name_at(offset) else {
                    if braced || at(offset).is_some_and(|next| "([0123456789@*#?$!-".contains(next))
                    {
                        return Err(fail(
                            offset,
                            "only $NAME and ${NAME} variable expansion is supported",
                        ));
                    }
                    value.push('$');
                    continue;
                };
                offset += reference.chars().count();
                if !braced && starts_with(offset, "\\\n") {
                    return Err(fail(
                        offset,
                        "line continuations inside variable references are not supported",
                    ));
                }
                if braced {
                    if at(offset) != Some('}') {
                        return Err(fail(
                            offset,
                            "only $NAME and ${NAME} variable expansion is supported",
                        ));
                    }
                    offset += 1;
                }
                let Some(known) = values.get(&reference) else {
                    return Err(fail(
                        offset,
                        "define referenced variables earlier in the config (HOME is available)",
                    ));
                };
                value.push_str(&known.clone());
                continue;
            }
            if character == '\\' {
                let Some(escaped) = at(offset + 1) else {
                    return Err(fail(offset, "incomplete escape"));
                };
                if quote.is_none() || "$`\"\\\n".contains(escaped) {
                    if escaped != '\n' {
                        value.push(escaped);
                    }
                    offset += 2;
                    continue;
                }
            }
            value.push(character);
            offset += 1;
        }
        if quote.is_some() {
            return Err(fail(offset, "unterminated quote"));
        }
        values.insert(name, value);
        space(&mut offset);
        if at(offset) == Some('#') {
            while offset < chars.len() && chars[offset] != '\n' {
                offset += 1;
            }
        }
        if offset < chars.len() && chars[offset] != '\n' {
            return Err(fail(offset, "expected one NAME=value assignment per line"));
        }
        if at(offset) == Some('\n') {
            offset += 1;
        }
    }
    Ok(values)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// name, contents, the values expected besides HOME (in order).
    type Fixture = (
        &'static str,
        &'static str,
        Vec<(&'static str, &'static str)>,
    );

    fn fixtures() -> Vec<Fixture> {
        vec![
            (
                "exports, comments, and hashes within words",
                "  # leading comment\n\texport A=first#part \t# trailing comment\nB= # empty\nC='# literal'\n",
                vec![("A", "first#part"), ("B", ""), ("C", "# literal")],
            ),
            (
                "prior assignments, overrides, and both variable reference forms",
                "A=initial\nA=updated\nB=\"$A ${A}suffix\"\nC=$B\nD=\"$HOME/cert.pem\"",
                vec![
                    ("A", "updated"),
                    ("B", "updated updatedsuffix"),
                    ("C", "updated updatedsuffix"),
                    ("D", "/test/home/cert.pem"),
                ],
            ),
            (
                "single quotes, escaped dollars, and quote concatenation",
                "A='$UNDEFINED and ${UNDEFINED}'\nB=\"\\$UNDEFINED and \\${UNDEFINED}\"\nC=unquoted\" double \"'single'\nD='can'\\''t'\n",
                vec![
                    ("A", "$UNDEFINED and ${UNDEFINED}"),
                    ("B", "$UNDEFINED and ${UNDEFINED}"),
                    ("C", "unquoted double single"),
                    ("D", "can't"),
                ],
            ),
            (
                "double-quoted and unquoted escapes",
                "A=\"backslash:\\\\ quote:\\\" tick:\\` other:\\q\"\nB=escaped\\ space\\#hash\\;operator\n",
                vec![
                    ("A", "backslash:\\ quote:\" tick:` other:\\q"),
                    ("B", "escaped space#hash;operator"),
                ],
            ),
            (
                "literal dollars followed by punctuation or end of input",
                "A=\"$.:/ $% $= $'literal' $\"\nB=$.,:/%=\nC=$",
                vec![
                    ("A", "$.:/ $% $= $'literal' $"),
                    ("B", "$.,:/%="),
                    ("C", "$"),
                ],
            ),
            (
                "line continuations and quoted newlines",
                "A=first\\\nsecond\nB=\"third\\\nfourth\"\nC='fifth\nsixth'\nD=\"seventh\neighth\"\n",
                vec![
                    ("A", "firstsecond"),
                    ("B", "thirdfourth"),
                    ("C", "fifth\nsixth"),
                    ("D", "seventh\neighth"),
                ],
            ),
            (
                "expanded metacharacters stay literal",
                "A='$(touch marker); `whoami` $HOME * & < >'\nB=\"$A\"\nC=$B\n",
                vec![
                    ("A", "$(touch marker); `whoami` $HOME * & < >"),
                    ("B", "$(touch marker); `whoami` $HOME * & < >"),
                    ("C", "$(touch marker); `whoami` $HOME * & < >"),
                ],
            ),
            (
                "ordinary variable names cannot mutate the object prototype",
                "constructor=literal\n__proto__=safe\nA=\"${__proto__} $constructor\"",
                vec![
                    ("constructor", "literal"),
                    ("__proto__", "safe"),
                    ("A", "safe literal"),
                ],
            ),
        ]
    }

    #[test]
    fn resolves_each_fixture() {
        for (name, contents, expected) in fixtures() {
            let mut want: BTreeMap<String, String> = expected
                .iter()
                .map(|(key, value)| ((*key).to_owned(), (*value).to_owned()))
                .collect();
            want.insert("HOME".into(), "/test/home".into());
            assert_eq!(
                resolve_launchd_environment(contents, "/config.env", "/test/home").unwrap(),
                want,
                "{name}"
            );
        }
    }

    /// Each fixture sourced by `sh` and `bash --posix` gives the same values.
    #[test]
    #[cfg(unix)]
    fn fixture_matches_shell_sourcing() {
        for (shell_name, shell) in [
            ("sh", &["/bin/sh"][..]),
            ("Bash POSIX", &["/bin/bash", "--posix"]),
        ] {
            if !std::path::Path::new(shell[0]).exists() {
                continue;
            }
            for (name, contents, expected) in fixtures() {
                let directory = tempfile::tempdir().unwrap();
                let path = directory.path().join("config's $ file.env");
                std::fs::write(&path, contents).unwrap();
                let names: Vec<String> = expected
                    .iter()
                    .map(|(key, _)| format!("\"${key}\""))
                    .collect();
                let output = std::process::Command::new(shell[0])
                    .args(&shell[1..])
                    .arg("-c")
                    .arg(format!(
                        "set -a; . \"$1\"; printf '%s\\0' {}",
                        names.join(" ")
                    ))
                    .arg("roamgate-environment-test")
                    .arg(&path)
                    .env_clear()
                    .env("HOME", "/test/home")
                    .output()
                    .unwrap();
                let what = format!("{name} with {shell_name}");
                assert!(output.status.success(), "{what}");
                assert_eq!(String::from_utf8_lossy(&output.stderr), "", "{what}");
                let stdout = String::from_utf8(output.stdout).unwrap();
                let mut values: Vec<&str> = stdout.split('\0').collect();
                values.pop();
                let want: Vec<&str> = expected.iter().map(|(_, value)| *value).collect();
                assert_eq!(values, want, "{what}");
            }
        }
    }

    #[test]
    fn rejects_unsupported_input_without_exposing_its_contents() {
        for contents in [
            "A=\"$(touch marker)\"",
            "A=`touch marker`",
            "A=$((1+1))",
            "A=$[1+1]",
            "A=safe; touch marker",
            "A=safe | cat",
            "A=safe > marker",
            "A=safe &",
            "A=<(cat marker)",
            "printf 'config output'",
            "source other.env",
            "A=one B=two",
            "export A",
            "A =value",
            "A= value",
            "A=~/file",
            "A=x:~/file",
            "A=${HOME:-fallback}",
            "A=$?",
            "A=$$",
            "A=$1",
            "A=$UNDEFINED",
            "A=${UNDEFINED}",
            "A=$A",
            "A=\"$\\\nHOME\"",
            "A=\"$HOME\\\n_SUFFIX\"",
            "A=\"$\\\n(touch marker)\"",
            "A=$'ansi\\nquote'",
            "A=$\"translated\"",
            "A='unterminated",
            "A=\"unterminated",
            "A=unfinished\\",
            "UID=123",
            "RANDOM=123",
            "BASH_ENV=/file",
            "IFS=other",
            "A=value\0",
            "A='value\0'",
            "A=escaped\\\0",
            "# comment\0\nA=value",
        ] {
            let error = resolve_launchd_environment(contents, "/config.env", "/test/home")
                .expect_err(contents);
            assert!(
                error.starts_with("invalid launchd environment at /config.env:1:"),
                "{contents:?}: {error}"
            );
            assert!(!error.contains(contents), "{contents:?}: {error}");
        }
    }

    #[test]
    fn rejects_shell_managed_variable() {
        for name in [
            "OPTIND",
            "GROUPS",
            "HISTCMD",
            "DIRSTACK",
            "FUNCNAME",
            "PIPESTATUS",
            "EPOCHSECONDS",
            "EPOCHREALTIME",
        ] {
            let error = resolve_launchd_environment(
                &format!("{name}=000000000000001\nROAMGATE_PASSWORD=\"${name}\""),
                "/config.env",
                "/test/home",
            )
            .unwrap_err();
            assert!(
                error.contains("shell-special variable assignments are not supported"),
                "{name}: {error}"
            );
        }
    }

    /// Why those names are refused: Bash would not give back what the file
    /// sets.
    #[test]
    #[cfg(unix)]
    fn bash_posix_rejects_or_normalizes_configured_shell_managed_values() {
        if !std::path::Path::new("/bin/bash").exists() {
            return;
        }
        for name in ["OPTIND", "GROUPS", "HISTCMD", "DIRSTACK", "FUNCNAME"] {
            let output = std::process::Command::new("/bin/bash")
                .args(["--posix", "-c"])
                .arg(format!(
                    "{name}=000000000000001; OTHER=value; ROAMGATE_PASSWORD=\"${name}\"; printf '%s' \"$ROAMGATE_PASSWORD\""
                ))
                .env_clear()
                .env("HOME", "/test/home")
                .output()
                .unwrap();
            assert_ne!(
                String::from_utf8_lossy(&output.stdout),
                "000000000000001",
                "{name}"
            );
        }
    }

    /// Only names defined earlier in the file expand, never the installer's
    /// own environment (read through nothing but the file).
    #[test]
    fn does_not_borrow_values_from_the_installers_environment() {
        // The variable is set in this process: resolution must not see it.
        let name = "PATH";
        assert!(std::env::var_os(name).is_some());
        let error = resolve_launchd_environment(
            &format!("ROAMGATE_PASSWORD=\"${name}\""),
            "/config.env",
            "/test/home",
        )
        .unwrap_err();
        assert!(error.contains("define referenced variables earlier in the config"));
    }
}
