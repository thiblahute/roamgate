//! Worktree command templates (worktree/command-template.ts): the checks of
//! a template, the script that runs it with its values as data, branch
//! names, and the install probe of its program.

use roamgate_git::{GitContext, Invocation, shell_quote};
use std::sync::LazyLock;
use std::time::Duration;

/// The environment variable each placeholder stands for, in export order.
/// Values never enter the command text: the script exports them first.
pub const WORKTREE_COMMAND_VARIABLES: [(&str, &str); 4] = [
    ("path", "ROAMGATE_WORKTREE_PATH"),
    ("branch", "ROAMGATE_WORKTREE_BRANCH"),
    ("base", "ROAMGATE_WORKTREE_BASE"),
    ("repo", "ROAMGATE_WORKTREE_REPO"),
];

static PLACEHOLDER: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r"\{(path|branch|base|repo|force)\}").unwrap());
static PLACEHOLDER_AT: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r"^\{(path|branch|base|repo|force)\}").unwrap());

/// Why a command template is refused, or `None` when it is usable. A
/// placeholder inside quotes is refused: Roamgate quotes it itself.
pub fn worktree_command_template_error(template: &str) -> Option<String> {
    let mut quote: Option<char> = None;
    let mut chars = template.char_indices();
    while let Some((index, char)) = chars.next() {
        if quote == Some('\'') {
            if char == '\'' {
                quote = None;
            }
        } else if char == '\\' {
            if PLACEHOLDER_AT.is_match(&template[index + 1..]) {
                return Some(
                    "Remove the escape before the placeholder: Roamgate quotes placeholders itself."
                        .into(),
                );
            }
            chars.next();
            continue;
        } else if quote == Some('"') {
            if char == '"' {
                quote = None;
            }
        } else if char == '\'' || char == '"' {
            quote = Some(char);
            continue;
        }
        if char != '{' {
            continue;
        }
        if let Some(found) = PLACEHOLDER_AT.captures(&template[index..])
            && quote.is_some()
        {
            return Some(format!(
                "Remove the quotes around {{{}}}: Roamgate quotes placeholders itself.",
                &found[1]
            ));
        }
    }
    quote.map(|_| "The command has an unterminated quote.".into())
}

/// Quotes a path for the shell, leaving a leading `~/` to the host's $HOME.
pub use roamgate_exec::quote::shell_quote_path as sh_quote_path;

/// The values a template may use; `force` makes `{force}` `--force`.
#[derive(Debug, Clone, Default)]
pub struct WorktreeCommandValues {
    pub path: Option<String>,
    pub branch: Option<String>,
    pub base: Option<String>,
    pub repo: Option<String>,
    pub force: bool,
}

impl WorktreeCommandValues {
    fn get(&self, name: &str) -> Option<&str> {
        match name {
            "path" => self.path.as_deref(),
            "branch" => self.branch.as_deref(),
            "base" => self.base.as_deref(),
            "repo" => self.repo.as_deref(),
            _ => None,
        }
    }
}

/// The script running a template: its exports, then the command.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorktreeCommandScript {
    pub exports: String,
    pub command: String,
}

/// Builds the script that runs a worktree command template: exports the
/// values, then the template with each placeholder replaced by its
/// variable. Errs for a template [`worktree_command_template_error`]
/// refuses.
pub fn worktree_command_script(
    template: &str,
    values: &WorktreeCommandValues,
) -> Result<WorktreeCommandScript, String> {
    if let Some(error) = worktree_command_template_error(template) {
        return Err(error);
    }
    let mut exports = Vec::new();
    for (name, variable) in WORKTREE_COMMAND_VARIABLES {
        let Some(value) = values.get(name) else {
            continue;
        };
        if value.contains('\0') {
            return Err(format!("Worktree {name} contains a NUL byte."));
        }
        let quoted = if name == "path" {
            sh_quote_path(value)
        } else {
            shell_quote(value)
        };
        exports.push(format!("export {variable}={quoted}"));
    }
    let mut missing = None;
    let command = PLACEHOLDER.replace_all(template, |found: &regex::Captures| {
        let name = &found[1];
        if name == "force" {
            return if values.force {
                "--force".into()
            } else {
                String::new()
            };
        }
        if values.get(name).is_none() && missing.is_none() {
            missing = Some(name.to_owned());
        }
        let variable = WORKTREE_COMMAND_VARIABLES
            .iter()
            .find(|(n, _)| *n == name)
            .map(|(_, v)| *v)
            .unwrap_or_default();
        format!("\"${variable}\"")
    });
    if let Some(name) = missing {
        return Err(format!("{{{name}}} is not available in this command."));
    }
    Ok(WorktreeCommandScript {
        exports: exports.join("; "),
        command: command.into_owned(),
    })
}

fn is_shell_syntax(c: char) -> bool {
    c.is_whitespace() || r#"$`'"\;|&<>(){}!*?[]~^:"#.contains(c)
}

/// Errs unless `branch` is a valid git branch name (the rules of `git
/// check-ref-format --branch`) without shell syntax characters.
pub fn validate_worktree_branch_name(branch: &str) -> Result<&str, String> {
    let invalid = |why: &str| {
        Err(format!(
            "Invalid branch name {}: {why}.",
            serde_json::to_string(branch).unwrap_or_default()
        ))
    };
    if branch.is_empty() {
        return invalid("it is empty");
    }
    if branch.encode_utf16().count() > 255 {
        return invalid("it is longer than 255 characters");
    }
    if branch.chars().any(|c| c <= '\x1f' || c == '\x7f') {
        return invalid("it has control characters");
    }
    // JS `\s` also takes the BOM and the separators `is_whitespace` has.
    if branch
        .chars()
        .any(|c| is_shell_syntax(c) || c == '\u{feff}')
    {
        return invalid("it has spaces or shell syntax characters");
    }
    if branch.starts_with('-') {
        return invalid("it starts with '-'");
    }
    if branch == "@" || branch.contains("@{") {
        return invalid("it is '@' or has '@{'");
    }
    if branch.contains("..") {
        return invalid("it has '..'");
    }
    if branch.starts_with('/') || branch.ends_with('/') || branch.contains("//") {
        return invalid("it has an empty path component");
    }
    if branch.ends_with('.') {
        return invalid("it ends with '.'");
    }
    if branch
        .split('/')
        .any(|part| part.starts_with('.') || part.ends_with(".lock"))
    {
        return invalid("a component starts with '.' or ends with '.lock'");
    }
    Ok(branch)
}

/// The first program a template runs and its git subcommand.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorktreeCommandProgram {
    pub program: String,
    pub subcommand: Option<String>,
}

fn word(text: &str, allowed: impl Fn(char) -> bool) -> Option<(&str, &str)> {
    let end = text.find(|c: char| !allowed(c)).unwrap_or(text.len());
    if end == 0 {
        return None;
    }
    let rest = &text[end..];
    // `(?=\s|$)`: the word ends at a space or the end.
    if !(rest.is_empty() || rest.starts_with(char::is_whitespace)) {
        return None;
    }
    Some((&text[..end], rest))
}

/// The first program a template runs (and its git subcommand), when the
/// template starts with a plain word; `None` when Roamgate cannot tell.
pub fn worktree_command_program(template: &str) -> Option<WorktreeCommandProgram> {
    let program_char = |c: char| c.is_ascii_alphanumeric() || "_./+-".contains(c);
    let (program, rest) = word(template.trim_start(), program_char)?;
    let second = rest.trim_start();
    let subcommand = if program == "git" && second.len() < rest.len() {
        word(second, |c| c.is_ascii_alphanumeric() || "_.+-".contains(c))
            .map(|(w, _)| w)
            .filter(|w| !w.starts_with('-'))
            .map(str::to_owned)
    } else {
        None
    };
    Some(WorktreeCommandProgram {
        program: program.to_owned(),
        subcommand,
    })
}

/// A script that exits 127 when the template's program (or git subcommand,
/// builtin, installed or alias) is missing, 0 otherwise.
pub fn worktree_command_probe_script(template: &str) -> Option<String> {
    let program = worktree_command_program(template)?;
    let mut lines = vec![format!(
        "command -v -- {} >/dev/null 2>&1 || exit 127",
        shell_quote(&program.program)
    )];
    if let Some(subcommand) = &program.subcommand {
        lines.push(format!(
            "git --list-cmds=main,others,alias 2>/dev/null | grep -qxF -- {} || exit 127",
            shell_quote(subcommand)
        ));
    }
    Some(lines.join("; "))
}

/// What runs a worktree script with `sh` on the host: the login shell
/// locally, `sh -c` over ssh whatever the remote login shell is.
pub fn worktree_shell_invocation(host: Option<&str>, script: &str) -> Invocation {
    match host {
        Some(host) => Invocation::ssh(host, &format!("sh -c {}", shell_quote(script)), None),
        None => Invocation::local(["sh", "-lc", script]),
    }
}

/// The install check is a `command -v`; it should never take long.
pub const WORKTREE_COMMAND_PROBE_TIMEOUT: Duration = Duration::from_millis(30_000);

/// Checks, apart from the command itself, whether the template's program
/// is installed on the host: a sentence saying what is missing, or `None`
/// when it is installed or Roamgate cannot tell.
pub async fn missing_worktree_command(
    template: &str,
    cx: &GitContext,
) -> Result<Option<String>, String> {
    missing_worktree_command_where(template, cx, || on_path("sh")).await
}

/// [`missing_worktree_command`], `has_sh` telling whether this machine has
/// an `sh`.
pub(crate) async fn missing_worktree_command_where(
    template: &str,
    cx: &GitContext,
    has_sh: impl Fn() -> bool,
) -> Result<Option<String>, String> {
    let Some(probe) = worktree_command_probe_script(template) else {
        return Ok(None);
    };
    let program = worktree_command_program(template).expect("probed");
    let name = match &program.subcommand {
        Some(sub) => format!("{} {sub}", program.program),
        None => program.program.clone(),
    };
    let host = cx.host();
    let place = match host {
        Some(host) => format!("on {host}"),
        None => "on this machine".to_owned(),
    };
    // The runner gives a missing program 127 where Bun's spawn threw
    // ENOENT: a missing `sh` here is looked for first (a Windows machine
    // without one).
    if host.is_none() && !has_sh() {
        return Ok(Some(format!("sh is not available {place}.")));
    }
    let ran = cx
        .run(
            worktree_shell_invocation(host, &probe),
            WORKTREE_COMMAND_PROBE_TIMEOUT,
        )
        .await
        .map_err(|error| error.0)?;
    Ok((ran.code == 127).then(|| format!("{name} is not installed {place}.")))
}

/// Whether `program` is a file in a directory of this machine's PATH.
fn on_path(program: &str) -> bool {
    let Some(path) = std::env::var_os("PATH") else {
        return false;
    };
    std::env::split_paths(&path).any(|dir| {
        dir.join(program).is_file()
            || (cfg!(windows) && dir.join(format!("{program}.exe")).is_file())
    })
}

#[cfg(test)]
mod tests;
