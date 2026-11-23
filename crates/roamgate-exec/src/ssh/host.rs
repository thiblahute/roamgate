//! The SSH hosts behind [`Host`]: [`Ssh`] (a POSIX shell on the far side)
//! and [`WindowsSsh`] (PowerShell), on the session slots, masters and
//! command lines of [`SshSessions`].
//!
//! - A command's words are quoted for the host's shell and sent as one ssh
//!   command: `cd -- <dir> && exec env -u X 'K=V' <words>` on POSIX, a
//!   script run as `powershell.exe -EncodedCommand` on Windows.
//! - `run` may change things and is never rerun; `run_read` goes through
//!   [`SshSessions::read_command_argv`], so a command whose master died
//!   under it reruns once on a connection of its own (ssh-sessions.ts
//!   `runSshCommand` with `sshReadCommandArgv`).
//! - A command's timeout is its budget across the wait for a session and
//!   the run, and bounds the command on the host too
//!   ([`super::sessions::with_remote_deadline`]).
//! - `stream` holds a long-lived session (a share of the master, else a
//!   connection of its own) for as long as the process runs; `hold` is a
//!   bridge on a connection of its own (`sshBridgeCommandArgv`).
//! - Files: `read_file` reads at most `limit + 1` bytes, `write_file`
//!   writes a temporary file beside the target and renames it over it,
//!   `list` gives each entry's kind, size and modification time without
//!   following symlinks. On Windows the bytes travel as base64 text, since
//!   PowerShell's pipeline is text.

use std::path::Path;

use base64::Engine as _;

use super::command::{
    InvalidDestination, SshCommand, ssh_bridge_command_argv, validate_ssh_destination,
};
use super::sessions::{SshOutput, SshSessionWait, SshSessions};
use super::windows::powershell_command;
use crate::host::{Entry, EntryKind, Host, HostError, HostFuture, HostKind};
use crate::process::{Command, ExecError, Output, Spawned};
use crate::quote::{Shell, powershell_quote, shell_quote};

/// What both SSH hosts share.
#[derive(Clone)]
struct Remote {
    destination: String,
    sessions: SshSessions,
    /// Options of the connection profile, given before the destination.
    trusted: Vec<String>,
    /// The ssh run: `ssh` on PATH unless set (tests point it at a fake).
    program: Option<String>,
    shell: Shell,
}

impl std::fmt::Debug for Remote {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Remote")
            .field("destination", &self.destination)
            .field("shell", &self.shell)
            .finish()
    }
}

/// An ssh run's output, with its stderr as text for the session rules.
struct SshRun {
    output: Output,
    stderr: String,
}

impl SshOutput for SshRun {
    fn code(&self) -> i32 {
        self.output.code
    }

    fn stderr(&self) -> &str {
        &self.stderr
    }

    fn set_stderr(&mut self, stderr: String) {
        self.output.stderr = stderr.clone().into_bytes();
        self.stderr = stderr;
    }
}

fn unsupported(program: &str, message: &str) -> ExecError {
    ExecError::Spawn {
        program: program.to_owned(),
        source: std::io::Error::new(std::io::ErrorKind::Unsupported, message.to_owned()),
    }
}

/// A command's line for a POSIX shell.
fn posix_line(command: &Command) -> String {
    let mut line = String::new();
    if let Some(cwd) = &command.cwd {
        line.push_str("cd -- ");
        line.push_str(&shell_quote(&cwd.to_string_lossy()));
        line.push_str(" && ");
    }
    line.push_str("exec ");
    if command.clear_env || !command.env.is_empty() {
        line.push_str("env ");
        if command.clear_env {
            line.push_str("-i ");
        }
        // Options first: `env` reads the words after an assignment as
        // the command.
        for (key, value) in &command.env {
            if value.is_none() {
                line.push_str("-u ");
                line.push_str(&shell_quote(key));
                line.push(' ');
            }
        }
        for (key, value) in &command.env {
            if let Some(value) = value {
                line.push_str(&shell_quote(&format!("{key}={value}")));
                line.push(' ');
            }
        }
    }
    let words: Vec<String> = command.argv.iter().map(|word| shell_quote(word)).collect();
    line.push_str(&words.join(" "));
    line
}

/// A command's script for PowerShell: its directory, its environment, its
/// words through `&`, and its exit code passed on.
fn powershell_line(command: &Command) -> Result<String, ExecError> {
    if command.clear_env {
        return Err(unsupported(
            command.program(),
            "a Windows host cannot run a command with an empty environment",
        ));
    }
    let mut script = String::from("$ErrorActionPreference = 'Stop'\n");
    if let Some(cwd) = &command.cwd {
        script.push_str(&format!(
            "Set-Location -LiteralPath {}\n",
            powershell_quote(&cwd.to_string_lossy())
        ));
    }
    for (key, value) in &command.env {
        let name = powershell_quote(&format!("Env:{key}"));
        match value {
            Some(value) => script.push_str(&format!(
                "Set-Item -LiteralPath {name} -Value {}\n",
                powershell_quote(value)
            )),
            None => script.push_str(&format!(
                "Remove-Item -LiteralPath {name} -ErrorAction SilentlyContinue\n"
            )),
        }
    }
    let words: Vec<String> = command
        .argv
        .iter()
        .map(|word| powershell_quote(word))
        .collect();
    script.push_str(&format!("& {}\nexit $LASTEXITCODE\n", words.join(" ")));
    Ok(powershell_command(&script))
}

impl Remote {
    fn new(
        sessions: SshSessions,
        destination: &str,
        shell: Shell,
    ) -> Result<Self, InvalidDestination> {
        Ok(Self {
            destination: validate_ssh_destination(destination)?.to_owned(),
            sessions,
            trusted: Vec::new(),
            program: None,
            shell,
        })
    }

    /// The remote line of `command` for this host's shell.
    fn line(&self, command: &Command) -> Result<String, ExecError> {
        if command.argv.is_empty() {
            return Err(ExecError::Empty);
        }
        match self.shell {
            Shell::PowerShell => powershell_line(command),
            _ => Ok(posix_line(command)),
        }
    }

    /// A script for the host's shell as one remote line.
    fn script_line(&self, script: &str) -> String {
        match self.shell {
            Shell::PowerShell => powershell_command(script),
            _ => format!("sh -c {}", shell_quote(script)),
        }
    }

    fn ssh_command(&self, line: &str, read: bool) -> Result<SshCommand, ExecError> {
        let built = if read {
            self.sessions
                .read_command_argv(&self.destination, line, &self.trusted, None)
        } else {
            self.sessions
                .command_argv(&self.destination, line, &self.trusted, None)
        };
        built.map_err(|error| unsupported("ssh", &error.to_string()))
    }

    /// The local words of an ssh command line, `ssh` replaced by the
    /// program set.
    fn local_argv(&self, argv: &[String]) -> Vec<String> {
        let mut argv = argv.to_vec();
        if let (Some(program), Some(first)) = (&self.program, argv.first_mut()) {
            *first = program.clone();
        }
        argv
    }

    /// Runs `line` with `command`'s input, cap and budget, inside the
    /// destination's session limit.
    async fn execute(
        &self,
        line: &str,
        command: &Command,
        read: bool,
    ) -> Result<Output, ExecError> {
        let ssh = self.ssh_command(line, read)?;
        let wait = SshSessionWait {
            timeout_ms: command.timeout.map(|limit| limit.as_millis() as u64),
            signal: None,
        };
        let runner = self.sessions.runner().clone();
        let ran = self
            .sessions
            .run(
                &ssh,
                |attempt, remaining| {
                    let mut local = Command::new(self.local_argv(&attempt.argv));
                    local.stdin = command.stdin.clone();
                    local.timeout = remaining
                        .map(std::time::Duration::from_millis)
                        .or(command.timeout);
                    local.output_cap = command.output_cap;
                    local.overflow = command.overflow;
                    local.kill_signal = command.kill_signal;
                    let runner = runner.clone();
                    async move {
                        let output = runner.run(&local).await?;
                        let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
                        Ok::<_, ExecError>(SshRun { output, stderr })
                    }
                },
                &wait,
            )
            .await?;
        Ok(ran.output)
    }

    async fn run(&self, command: &Command, read: bool) -> Result<Output, ExecError> {
        let line = self.line(command)?;
        self.execute(&line, command, read).await
    }

    async fn stream(&self, command: &Command) -> Result<Spawned, ExecError> {
        let ssh = self.ssh_command(&self.line(command)?, true)?;
        let held = self
            .sessions
            .hold(&ssh, &SshSessionWait::default(), true)
            .await?;
        let local = Command::new(self.local_argv(&held.command.argv));
        let spawned = self
            .sessions
            .runner()
            .spawn(&local, command.stdin.is_some())?;
        Ok(spawned.keep(held))
    }

    async fn hold(&self, command: &Command) -> Result<Spawned, ExecError> {
        let argv = ssh_bridge_command_argv(&self.destination, &self.line(command)?)
            .map_err(|error| unsupported("ssh", &error.to_string()))?;
        self.sessions
            .runner()
            .spawn(&Command::new(self.local_argv(&argv)), true)
    }

    /// Runs a file script, failing as the path's error when it fails.
    async fn file_script(
        &self,
        path: &Path,
        script: &str,
        input: Option<Vec<u8>>,
        read: bool,
    ) -> Result<Output, HostError> {
        let mut command = Command::new(["file"]);
        command.stdin = input;
        let output = self
            .execute(&self.script_line(script), &command, read)
            .await?;
        if output.code != 0 {
            let detail = String::from_utf8_lossy(&output.stderr).trim().to_owned();
            let kind = if detail.contains("No such file")
                || detail.contains("does not exist")
                || detail.contains("Cannot find path")
            {
                std::io::ErrorKind::NotFound
            } else {
                std::io::ErrorKind::Other
            };
            let detail = if detail.is_empty() {
                format!("exited {}", output.code)
            } else {
                detail
            };
            return Err(HostError::Io {
                path: path.display().to_string(),
                source: std::io::Error::new(kind, detail),
            });
        }
        Ok(output)
    }

    async fn read_file(&self, path: &Path, limit: u64) -> Result<Vec<u8>, HostError> {
        let text = path.to_string_lossy();
        let wanted = limit.saturating_add(1);
        let bytes = match self.shell {
            Shell::PowerShell => {
                let script = format!(
                    "$ErrorActionPreference = 'Stop'\n\
                     $stream = [IO.File]::OpenRead({})\n\
                     try {{\n\
                     $buffer = New-Object byte[] ([Math]::Min([long]{wanted}, $stream.Length + 1))\n\
                     $read = 0\n\
                     while ($read -lt $buffer.Length) {{ $n = $stream.Read($buffer, $read, $buffer.Length - $read); if ($n -le 0) {{ break }}; $read += $n }}\n\
                     [Console]::Out.Write([Convert]::ToBase64String($buffer, 0, $read))\n\
                     }} finally {{ $stream.Dispose() }}\n",
                    powershell_quote(&text)
                );
                let output = self.file_script(path, &script, None, true).await?;
                decode_base64(path, &output.stdout)?
            }
            _ => {
                let script = format!("exec head -c {wanted} -- {}", shell_quote(&text));
                self.file_script(path, &script, None, true).await?.stdout
            }
        };
        if bytes.len() as u64 > limit {
            return Err(HostError::TooLarge {
                path: path.display().to_string(),
                limit,
            });
        }
        Ok(bytes)
    }

    async fn write_file(&self, path: &Path, bytes: &[u8]) -> Result<(), HostError> {
        let text = path.to_string_lossy();
        match self.shell {
            Shell::PowerShell => {
                let script = format!(
                    "$ErrorActionPreference = 'Stop'\n\
                     $target = [IO.Path]::GetFullPath({})\n\
                     $temporary = Join-Path ([IO.Path]::GetDirectoryName($target)) ('.roamgate-write.' + [Guid]::NewGuid().ToString('N') + '.tmp')\n\
                     try {{\n\
                     [IO.File]::WriteAllBytes($temporary, [Convert]::FromBase64String([Console]::In.ReadToEnd()))\n\
                     Move-Item -LiteralPath $temporary -Destination $target -Force\n\
                     }} catch {{ Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue; throw }}\n",
                    powershell_quote(&text)
                );
                let input = base64::engine::general_purpose::STANDARD.encode(bytes);
                self.file_script(path, &script, Some(input.into_bytes()), false)
                    .await?;
            }
            _ => {
                // mktemp makes 0600 files; the file gets the mode a new
                // file would (0666 less the umask), as the local write.
                let script = format!(
                    "set -e\n\
                     target={}\n\
                     temporary=$(mktemp \"$(dirname -- \"$target\")/.roamgate-write.XXXXXXXX\")\n\
                     trap 'rm -f -- \"$temporary\"' EXIT\n\
                     cat > \"$temporary\"\n\
                     chmod \"$(printf '%o' $(( 0666 & ~0$(umask) )))\" \"$temporary\"\n\
                     mv -f -- \"$temporary\" \"$target\"\n\
                     trap - EXIT\n",
                    shell_quote(&text)
                );
                self.file_script(path, &script, Some(bytes.to_vec()), false)
                    .await?;
            }
        }
        Ok(())
    }

    async fn list(&self, path: &Path) -> Result<Vec<Entry>, HostError> {
        let text = path.to_string_lossy();
        let (script, mtime_scale) = match self.shell {
            Shell::PowerShell => (
                format!(
                    "$ErrorActionPreference = 'Stop'\n\
                     Get-ChildItem -Force -LiteralPath {} | ForEach-Object {{\n\
                     $kind = if ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) {{ 'symlink' }} elseif ($_.PSIsContainer) {{ 'directory' }} else {{ 'file' }}\n\
                     $size = if ($kind -eq 'file') {{ $_.Length }} else {{ 0 }}\n\
                     $mtime = ([DateTimeOffset]$_.LastWriteTimeUtc).ToUnixTimeMilliseconds()\n\
                     [Console]::Out.Write($kind + \"`t\" + $size + \"`t\" + $mtime + \"`t\" + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($_.Name)) + \"`n\")\n\
                     }}\n",
                    powershell_quote(&text)
                ),
                1,
            ),
            _ => (
                format!(
                    "set -eu\n\
                     cd -- {}\n\
                     for name in * .[!.]* ..?*; do\n\
                     [ -e \"$name\" ] || [ -L \"$name\" ] || continue\n\
                     if [ -L \"$name\" ]; then kind=symlink; elif [ -d \"$name\" ]; then kind=directory; elif [ -f \"$name\" ]; then kind=file; else kind=other; fi\n\
                     size=0\n\
                     if [ \"$kind\" = file ]; then size=\"$(stat -c %s \"./$name\" 2>/dev/null || stat -f %z \"./$name\" 2>/dev/null || printf 0)\"; fi\n\
                     mtime=\"$(stat -c %Y \"./$name\" 2>/dev/null || stat -f %m \"./$name\" 2>/dev/null || true)\"\n\
                     printf '%s\\t%s\\t%s\\t%s\\n' \"$kind\" \"$size\" \"$mtime\" \"$(printf '%s' \"$name\" | base64 | tr -d '\\n')\"\n\
                     done\n",
                    shell_quote(&text)
                ),
                1000,
            ),
        };
        let output = self.file_script(path, &script, None, true).await?;
        parse_list(path, &output.stdout, mtime_scale)
    }
}

fn decode_base64(path: &Path, text: &[u8]) -> Result<Vec<u8>, HostError> {
    let text: Vec<u8> = text
        .iter()
        .copied()
        .filter(|byte| !byte.is_ascii_whitespace())
        .collect();
    base64::engine::general_purpose::STANDARD
        .decode(text)
        .map_err(|error| HostError::Io {
            path: path.display().to_string(),
            source: std::io::Error::new(std::io::ErrorKind::InvalidData, error.to_string()),
        })
}

/// The `list` scripts' lines: `<kind>\t<size>\t<mtime>\t<base64 name>`,
/// the mtime in seconds times `mtime_scale` (POSIX) or milliseconds.
fn parse_list(path: &Path, stdout: &[u8], mtime_scale: i64) -> Result<Vec<Entry>, HostError> {
    let text = String::from_utf8_lossy(stdout);
    let mut entries = Vec::new();
    for line in text.lines() {
        let line = line.trim_end_matches('\r');
        if line.is_empty() {
            continue;
        }
        let fields: Vec<&str> = line.split('\t').collect();
        let [kind, size, mtime, name] = fields.as_slice() else {
            return Err(HostError::Io {
                path: path.display().to_string(),
                source: std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    format!("unreadable entry line: {line}"),
                ),
            });
        };
        let name = String::from_utf8_lossy(&decode_base64(path, name.as_bytes())?).into_owned();
        entries.push(Entry {
            name,
            kind: match *kind {
                "file" => EntryKind::File,
                "directory" => EntryKind::Directory,
                "symlink" => EntryKind::Symlink,
                _ => EntryKind::Other,
            },
            size: size.parse().unwrap_or(0),
            modified_ms: mtime.parse::<i64>().ok().map(|value| value * mtime_scale),
        });
    }
    entries.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(entries)
}

macro_rules! remote_host {
    ($name:ident, $shell:expr, $kind:ident, $doc:literal) => {
        #[doc = $doc]
        #[derive(Debug, Clone)]
        pub struct $name {
            remote: Remote,
        }

        impl $name {
            /// The host at `destination` (an OpenSSH alias or user@host).
            pub fn new(
                sessions: SshSessions,
                destination: &str,
            ) -> Result<Self, InvalidDestination> {
                Ok(Self {
                    remote: Remote::new(sessions, destination, $shell)?,
                })
            }

            /// The connection profile's own ssh options, before the
            /// destination.
            pub fn with_options(mut self, trusted: Vec<String>) -> Self {
                self.remote.trusted = trusted;
                self
            }

            /// Runs `program` instead of `ssh` (a fake in tests).
            pub fn with_program(mut self, program: impl Into<String>) -> Self {
                self.remote.program = Some(program.into());
                self
            }

            pub fn destination(&self) -> &str {
                &self.remote.destination
            }
        }

        impl Host for $name {
            fn kind(&self) -> HostKind {
                HostKind::$kind(self.remote.destination.clone())
            }

            fn shell(&self) -> Shell {
                self.remote.shell
            }

            fn run<'a>(
                &'a self,
                command: &'a Command,
            ) -> HostFuture<'a, Result<Output, ExecError>> {
                Box::pin(self.remote.run(command, false))
            }

            fn run_read<'a>(
                &'a self,
                command: &'a Command,
            ) -> HostFuture<'a, Result<Output, ExecError>> {
                Box::pin(self.remote.run(command, true))
            }

            fn stream<'a>(
                &'a self,
                command: &'a Command,
            ) -> HostFuture<'a, Result<Spawned, ExecError>> {
                Box::pin(self.remote.stream(command))
            }

            fn hold<'a>(
                &'a self,
                command: &'a Command,
            ) -> HostFuture<'a, Result<Spawned, ExecError>> {
                Box::pin(self.remote.hold(command))
            }

            fn read_file<'a>(
                &'a self,
                path: &'a Path,
                limit: u64,
            ) -> HostFuture<'a, Result<Vec<u8>, HostError>> {
                Box::pin(self.remote.read_file(path, limit))
            }

            fn write_file<'a>(
                &'a self,
                path: &'a Path,
                bytes: &'a [u8],
            ) -> HostFuture<'a, Result<(), HostError>> {
                Box::pin(self.remote.write_file(path, bytes))
            }

            fn list<'a>(&'a self, path: &'a Path) -> HostFuture<'a, Result<Vec<Entry>, HostError>> {
                Box::pin(self.remote.list(path))
            }
        }
    };
}

remote_host!(
    Ssh,
    Shell::Posix,
    Ssh,
    "A POSIX host over SSH: commands and file scripts run by its shell."
);
remote_host!(
    WindowsSsh,
    Shell::PowerShell,
    WindowsSsh,
    "A Windows host over SSH: commands and file scripts run by PowerShell."
);

#[cfg(all(test, unix))]
mod tests;
