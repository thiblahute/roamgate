//! `roamgate completion <bash|zsh|fish>` (cli/completion.ts): a shell
//! completion script naming every command, its actions and its flags.

use crate::args::{EXIT_OK, Failure, parse_command_args, wants_help};
use crate::context::CliContext;
use crate::index::{CliCommand, Outcome, cli_commands, command_help, rust_runner, server_flags};

const SHELLS: &[&str] = &["bash", "zsh", "fish"];

/// Words offered after `roamgate <command>`.
fn command_words(command: &CliCommand) -> Vec<String> {
    command
        .actions
        .iter()
        .chain(&command.flags)
        .cloned()
        .chain(["--help".to_owned()])
        .collect()
}

/// Completion words are fixed identifiers and flags: anything a shell
/// could interpret is refused rather than quoted.
fn shell_words(words: &[String]) -> Result<String, Failure> {
    for word in words {
        let valid = !word.is_empty()
            && word
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-');
        if !valid {
            return Err(Failure::Failed(format!("invalid completion word: {word}")));
        }
    }
    Ok(words.join(" "))
}

fn word(text: &str) -> Result<String, Failure> {
    shell_words(&[text.to_owned()])
}

/// The script for `shell` (renderCompletion).
pub fn render_completion(shell: &str, commands: &[CliCommand]) -> Result<String, Failure> {
    let top_level: Vec<String> = commands
        .iter()
        .map(|command| command.name.clone())
        .chain(server_flags())
        .collect();
    if shell == "bash" {
        let cases = commands
            .iter()
            .map(|command| {
                Ok(format!(
                    "    {}) words=\"{}\" ;;",
                    command.name,
                    shell_words(&command_words(command))?
                ))
            })
            .collect::<Result<Vec<_>, Failure>>()?
            .join("\n");
        return Ok(format!(
            r#"# roamgate bash completion
_roamgate() {{
  local cur words
  cur="${{COMP_WORDS[COMP_CWORD]}}"
  if [ "$COMP_CWORD" -eq 1 ]; then
    COMPREPLY=($(compgen -W "{}" -- "$cur"))
    return
  fi
  case "${{COMP_WORDS[1]}}" in
{cases}
    *) words="" ;;
  esac
  COMPREPLY=($(compgen -W "$words" -- "$cur"))
}}
complete -o default -F _roamgate roamgate
"#,
            shell_words(&top_level)?
        ));
    }
    if shell == "zsh" {
        let cases = commands
            .iter()
            .map(|command| {
                Ok(format!(
                    "    {}) compadd -- {} ;;",
                    command.name,
                    shell_words(&command_words(command))?
                ))
            })
            .collect::<Result<Vec<_>, Failure>>()?
            .join("\n");
        return Ok(format!(
            r#"#compdef roamgate
# roamgate zsh completion
_roamgate() {{
  if (( CURRENT == 2 )); then
    compadd -- {}
    return
  fi
  case "$words[2]" in
{cases}
    *) _files ;;
  esac
}}
if [ "$funcstack[1]" = "_roamgate" ]; then
  _roamgate "$@"
else
  compdef _roamgate roamgate
fi
"#,
            shell_words(&top_level)?
        ));
    }
    let mut lines = vec![
        "# roamgate fish completion".to_owned(),
        "complete -c roamgate -f".to_owned(),
    ];
    for flag in server_flags() {
        lines.push(format!(
            "complete -c roamgate -n __fish_use_subcommand -l {}",
            word(flag.get(2..).unwrap_or_default())?
        ));
    }
    for command in commands {
        let summary = command.summary.replace('\'', "");
        lines.push(format!(
            "complete -c roamgate -n __fish_use_subcommand -a {} -d '{summary}'",
            word(&command.name)?
        ));
        let condition = format!("'__fish_seen_subcommand_from {}'", command.name);
        if !command.actions.is_empty() {
            lines.push(format!(
                "complete -c roamgate -n {condition} -a '{}'",
                shell_words(&command.actions)?
            ));
        }
        for flag in command.flags.iter().map(String::as_str).chain(["--help"]) {
            lines.push(format!(
                "complete -c roamgate -n {condition} -l {}",
                word(flag.get(2..).unwrap_or_default())?
            ));
        }
    }
    Ok(format!("{}\n", lines.join("\n")))
}

/// `roamgate completion <args>`.
pub async fn run(args: &[String], context: &CliContext) -> Result<Outcome, Failure> {
    if wants_help(args) || args.is_empty() {
        context.log(command_help("completion"));
        return Ok(Outcome::Code(EXIT_OK));
    }
    let parsed = parse_command_args(args, &[], 1)?;
    let shell = parsed.positionals[0].as_str();
    if !SHELLS.contains(&shell) {
        return Err(Failure::Usage(format!(
            "unsupported shell: {shell} (expected bash, zsh or fish)"
        )));
    }
    let script = render_completion(shell, &cli_commands(rust_runner))?;
    context.log(script.trim_end());
    Ok(Outcome::Code(EXIT_OK))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::context::testing::TestCli;

    /// Whether `shell` runs here (a toolbox may lack it).
    fn runnable(shell: &str) -> bool {
        std::process::Command::new(shell)
            .args(["-c", "exit 0"])
            .output()
            .is_ok_and(|output| output.status.success())
    }

    fn commands() -> Vec<CliCommand> {
        cli_commands(rust_runner)
    }

    #[test]
    fn shell_script_parses_and_names_every_command() {
        for shell in ["bash", "zsh"] {
            if !runnable(shell) {
                eprintln!("skipped: no {shell}");
                continue;
            }
            let cli = TestCli::new();
            let script = render_completion(shell, &commands()).unwrap();
            let path = cli.home().join(format!("completion.{shell}"));
            std::fs::write(&path, &script).unwrap();
            let check = std::process::Command::new(shell)
                .arg("-n")
                .arg(&path)
                .output()
                .unwrap();
            assert_eq!(String::from_utf8_lossy(&check.stderr), "", "{shell}");
            assert!(check.status.success(), "{shell}");
            for command in commands() {
                assert!(script.contains(&command.name), "{shell}: {}", command.name);
            }
        }
    }

    #[test]
    fn bash_completes_subcommand_actions() {
        if !runnable("bash") {
            eprintln!("skipped: no bash");
            return;
        }
        let cli = TestCli::new();
        let path = cli.home().join("completion.bash");
        std::fs::write(&path, render_completion("bash", &commands()).unwrap()).unwrap();
        let output = std::process::Command::new("bash")
            .args([
                "-c",
                "source \"$1\"; COMP_WORDS=(roamgate config s); COMP_CWORD=2; _roamgate; echo \"${COMPREPLY[*]}\"",
                "bash",
            ])
            .arg(&path)
            .output()
            .unwrap();
        assert_eq!(String::from_utf8_lossy(&output.stdout).trim(), "show set");
    }

    #[test]
    fn fish_script_registers_commands_with_descriptions() {
        let script = render_completion("fish", &commands()).unwrap();
        assert!(script.contains(
            "complete -c roamgate -n __fish_use_subcommand -a doctor -d 'diagnose the installation and suggest fixes'"
        ));
        assert!(script.contains("complete -c roamgate -n '__fish_seen_subcommand_from url' -l qr"));
    }

    #[tokio::test]
    async fn rejects_unknown_shells() {
        let cli = TestCli::new();
        assert_eq!(cli.run_cli(&["completion", "tcsh"]).await, 2);
        assert_eq!(
            cli.errors(),
            [
                "roamgate completion: unsupported shell: tcsh (expected bash, zsh or fish)",
                "Run `roamgate completion --help` for usage."
            ]
        );
        assert_eq!(cli.run_cli(&["completion", "bash"]).await, 0);
    }

    /// The scripts are byte for byte the Bun CLI's (printed with
    /// `bun server/src/index.ts completion <shell>`).
    #[test]
    fn scripts_are_the_bun_clis() {
        for shell in SHELLS {
            let golden = match *shell {
                "bash" => include_str!("completion/bash.txt"),
                "zsh" => include_str!("completion/zsh.txt"),
                _ => include_str!("completion/fish.txt"),
            };
            let script = render_completion(shell, &commands()).unwrap();
            assert_eq!(format!("{}\n", script.trim_end()), golden, "{shell}");
        }
    }
}
