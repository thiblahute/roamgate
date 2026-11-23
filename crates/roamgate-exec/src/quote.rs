//! Shell quoting, in one place: the POSIX `shQuote` of process-utils,
//! mr-reviews/clones, archive/hosts and archive/session, activity/repo-info
//! and the worktree command template; PowerShell's single quotes
//! (bridge/ssh-windows); and the paths typed into a terminal
//! (http/terminal-path-text, `contract/vectors/terminal-path-text.json`).
//!
//! activity/repo-info.ts closes and reopens with `'"'"'` where the others
//! write `'\''`: the same word for sh, so it takes [`shell_quote`] too.

/// The shells a command line is written for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Shell {
    /// sh, bash, zsh: POSIX quoting.
    Posix,
    /// Windows PowerShell.
    PowerShell,
    /// Git for Windows' bash: POSIX quoting of a path with forward slashes.
    GitBash,
}

/// One POSIX shell word holding `value` exactly: single quotes, a quote
/// inside written `'\''`.
pub fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

/// One PowerShell word holding `value` exactly: single quotes, a quote
/// inside doubled.
pub fn powershell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

/// `value` as one word of `shell`.
pub fn quote(shell: Shell, value: &str) -> String {
    match shell {
        Shell::Posix => shell_quote(value),
        Shell::PowerShell => powershell_quote(value),
        Shell::GitBash => shell_quote(&value.replace('\\', "/")),
    }
}

/// A path for a POSIX shell, `~/` kept as the home (`"$HOME"/'rest'`), as
/// the worktree command template writes it.
pub fn shell_quote_path(path: &str) -> String {
    match path.strip_prefix("~/") {
        Some(rest) => format!("\"$HOME\"/{}", shell_quote(rest)),
        None => shell_quote(path),
    }
}

/// The words of `argv` as one POSIX command line.
pub fn shell_join<S: AsRef<str>>(argv: &[S]) -> String {
    argv.iter()
        .map(|word| shell_quote(word.as_ref()))
        .collect::<Vec<_>>()
        .join(" ")
}

/// Which conventions a terminal's host follows for a typed path.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PathStyle {
    Posix,
    /// PowerShell and Git Bash on Windows.
    Windows,
}

impl PathStyle {
    /// The style of a Node `process.platform` name: `win32` is Windows,
    /// everything else POSIX.
    pub fn from_node_platform(platform: &str) -> Self {
        if platform == "win32" {
            Self::Windows
        } else {
            Self::Posix
        }
    }
}

fn safe_path(path: &str) -> bool {
    !path.is_empty()
        && path.bytes().all(|byte| {
            byte.is_ascii_alphanumeric()
                || matches!(
                    byte,
                    b'_' | b'-' | b'.' | b'/' | b':' | b'@' | b'%' | b'+' | b'='
                )
        })
}

/// An uploaded path as typed into a terminal, by host conventions rather
/// than by the shell detected: safe paths stay bare (agents detect images
/// by them); Windows covers PowerShell and Git Bash with forward slashes,
/// and commas need quotes in PowerShell's argument mode.
pub fn terminal_path_text(path: &str, style: PathStyle) -> String {
    match style {
        PathStyle::Windows => {
            // Bash treats backslashes as escapes; Windows APIs, PowerShell
            // and Git Bash all accept forward slashes.
            let slashed = path.replace('\\', "/");
            if safe_path(&slashed) {
                return slashed;
            }
            if !slashed.contains('\'') {
                return format!("'{slashed}'");
            }
            // Windows paths cannot hold double quotes; double quotes still
            // expand `$` in both shells and backticks in PowerShell.
            if !slashed.contains(['$', '`']) {
                return format!("\"{slashed}\"");
            }
            // This rare mix is PowerShell-only.
            powershell_quote(&slashed)
        }
        PathStyle::Posix => {
            if safe_path(path) {
                path.to_owned()
            } else {
                shell_quote(path)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use roamgate_protocol::vectors;
    use serde_json::Value;

    #[test]
    fn terminal_path_text_vectors() {
        let file = vectors::load("terminal-path-text");
        for case in &file.cases {
            for call in &case.calls {
                match call.target().as_str() {
                    "terminal-path-text.terminalPathText" => {
                        let path = vectors::text(&call.args[0]).expect("path");
                        let platform = call.args[1].as_str().expect("platform");
                        let got =
                            terminal_path_text(&path, PathStyle::from_node_platform(platform));
                        assert_eq!(
                            Some(&Value::String(got)),
                            call.result.as_ref(),
                            "{}",
                            case.title()
                        );
                    }
                    other => panic!("{}: no Rust side for {other}", case.title()),
                }
            }
        }
    }

    #[test]
    fn posix_words_survive_quotes_and_expansions() {
        assert_eq!(shell_quote("plain"), "'plain'");
        assert_eq!(shell_quote("it's"), "'it'\\''s'");
        assert_eq!(shell_quote(""), "''");
        assert_eq!(shell_join(&["a b", "$HOME"]), "'a b' '$HOME'");
        assert_eq!(shell_quote_path("~/src/x y"), "\"$HOME\"/'src/x y'");
        assert_eq!(shell_quote_path("/abs"), "'/abs'");
        // What sh makes of them.
        let words = ["space ' quote \" & $HOME; $(echo injected)", "", "a\nb"];
        let script = format!("printf '%s\\0' {}", shell_join(&words));
        let out = std::process::Command::new("sh")
            .args(["-c", &script])
            .output()
            .unwrap();
        let got: Vec<&[u8]> = out.stdout.split(|byte| *byte == 0).collect();
        for (index, word) in words.iter().enumerate() {
            assert_eq!(got[index], word.as_bytes());
        }
    }

    #[cfg(unix)]
    #[test]
    fn posix_shell_receives_each_supported_path_as_one_unchanged_argument() {
        for (path, platform) in [
            ("/tmp/John,Doe/img.png", "linux"),
            ("/tmp/John Doe/img.png", "linux"),
            ("/tmp/O'B$n/img.png", "linux"),
            ("C:\\Users\\John,Doe\\img.png", "win32"),
            ("C:\\Users\\John Doe\\img.png", "win32"),
            ("C:\\Users\\O'Brien\\img.png", "win32"),
        ] {
            let text = terminal_path_text(path, PathStyle::from_node_platform(platform));
            let out = std::process::Command::new("sh")
                .args(["-c", &format!("printf '%s\\n' {text}")])
                .output()
                .unwrap();
            assert_eq!(out.status.code(), Some(0), "{path}");
            let expected = if platform == "win32" {
                path.replace('\\', "/")
            } else {
                path.to_owned()
            };
            assert_eq!(
                String::from_utf8_lossy(&out.stdout),
                format!("{expected}\n")
            );
        }
    }

    #[test]
    fn powershell_and_git_bash_words() {
        assert_eq!(powershell_quote("O'Brien"), "'O''Brien'");
        assert_eq!(quote(Shell::PowerShell, "a'b"), "'a''b'");
        assert_eq!(quote(Shell::GitBash, "C:\\x y\\z"), "'C:/x y/z'");
        assert_eq!(quote(Shell::Posix, "a'b"), "'a'\\''b'");
    }
}
