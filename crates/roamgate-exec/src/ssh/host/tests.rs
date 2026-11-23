//! The SSH hosts against a fake `ssh` that runs the remote line on this
//! machine (POSIX) or answers as a Windows host would, recording each call.

use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::AtomicBool;

use base64::Engine as _;
use roamgate_base::clock::SystemClock;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use super::{Ssh, WindowsSsh};
use crate::host::{EntryKind, Host, HostError, HostKind};
use crate::process::Command;
use crate::quote::Shell;
use crate::ssh::sessions::SshSessions;
use crate::ssh::sessions::tests::fake_master_with;

/// Records its words (one call a line, words split by `|`), refuses a
/// multiplexed command while `master-dead` exists as OpenSSH does when its
/// master went away mid-command, then runs the remote line with sh, or on
/// a `windows` host keeps its input in `stdin` and prints `answer`.
const FAKE_SSH: &str = r#"#!/bin/sh
dir=$(dirname "$0")
(IFS='|'; printf '%s\n' "$*") >> "$dir/calls"
mux=0
for word in "$@"; do [ "$word" = -S ] && mux=1; done
if [ $mux = 1 ] && [ -e "$dir/master-dead" ]; then
  echo "Connection to fake-host closed by remote host." >&2
  exit 255
fi
while [ $# -gt 0 ] && [ "$1" != -- ]; do shift; done
shift 2
if [ -e "$dir/windows" ]; then
  cat > "$dir/stdin"
  cat "$dir/answer"
  exit "$(cat "$dir/code" 2>/dev/null || echo 0)"
fi
exec sh -c "$1"
"#;

struct Fake {
    dir: tempfile::TempDir,
    sessions: SshSessions,
}

impl Fake {
    fn new() -> Self {
        let dir = tempfile::Builder::new()
            .prefix("rg-ssh-host-")
            .tempdir_in("/tmp")
            .unwrap();
        let ssh = dir.path().join("ssh");
        std::fs::write(&ssh, FAKE_SSH).unwrap();
        std::fs::set_permissions(&ssh, std::fs::Permissions::from_mode(0o755)).unwrap();
        Self {
            dir,
            sessions: SshSessions::with_platform(Arc::new(SystemClock), false),
        }
    }

    fn program(&self) -> String {
        self.dir.path().join("ssh").to_string_lossy().into_owned()
    }

    fn posix(&self) -> Ssh {
        Ssh::new(self.sessions.clone(), "fake-host")
            .unwrap()
            .with_program(self.program())
    }

    fn windows(&self, answer: &str) -> WindowsSsh {
        std::fs::write(self.dir.path().join("windows"), "").unwrap();
        std::fs::write(self.dir.path().join("answer"), answer).unwrap();
        WindowsSsh::new(self.sessions.clone(), "win-host")
            .unwrap()
            .with_program(self.program())
    }

    fn calls(&self) -> Vec<Vec<String>> {
        std::fs::read_to_string(self.dir.path().join("calls"))
            .unwrap_or_default()
            .lines()
            .map(|line| line.split('|').map(str::to_owned).collect())
            .collect()
    }

    fn scratch(&self) -> PathBuf {
        let scratch = self.dir.path().join("scratch");
        std::fs::create_dir_all(&scratch).unwrap();
        scratch
    }
}

/// The script of a `powershell.exe -EncodedCommand` line.
fn powershell_script(line: &str) -> String {
    assert!(line.starts_with("powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand "));
    let encoded = line.rsplit(' ').next().unwrap();
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .unwrap();
    let units: Vec<u16> = bytes
        .chunks(2)
        .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
        .collect();
    String::from_utf16(&units).unwrap()
}

#[tokio::test]
async fn a_posix_host_runs_words_in_their_directory_with_their_environment_and_input() {
    let fake = Fake::new();
    let host = fake.posix();
    assert_eq!(host.kind(), HostKind::Ssh("fake-host".into()));
    assert_eq!(host.shell(), Shell::Posix);
    let scratch = fake.scratch();
    let output = host
        .run(
            &Command::new([
                "sh",
                "-c",
                "pwd -P; printf '%s|%s|' \"$GREETING\" \"${GONE-unset}\"; cat",
            ])
            .cwd(&scratch)
            .env("GREETING", "it's a 'quoted' $value")
            .env_remove("GONE")
            .stdin("from stdin"),
        )
        .await
        .unwrap();
    assert_eq!(output.code, 0, "{}", output.stderr_text());
    assert_eq!(
        output.stdout_text(),
        format!(
            "{}\nit's a 'quoted' $value|unset|from stdin",
            scratch.canonicalize().unwrap().display()
        )
    );
    // One ssh command line, the remote line last, after the destination.
    let calls = fake.calls();
    assert_eq!(calls.len(), 1);
    let call = &calls[0];
    let at = call.iter().position(|word| word == "--").unwrap();
    assert_eq!(call[at + 1], "fake-host");
    assert!(call[at + 2].starts_with("cd -- '"));
    assert!(call.contains(&"BatchMode=yes".to_owned()));
    // A failure is its exit code, never rerun.
    let failed = host
        .run(&Command::new(["sh", "-c", "echo nope >&2; exit 3"]))
        .await
        .unwrap();
    assert_eq!((failed.code, failed.stderr_text().trim()), (3, "nope"));
    assert_eq!(fake.calls().len(), 2);
}

#[tokio::test]
async fn a_read_reruns_once_cold_when_its_master_died_and_a_write_does_not() {
    let fake = Fake::new();
    let host = fake.posix();
    let _master = fake_master_with(
        &fake.sessions,
        "fake-host",
        Arc::new(AtomicBool::new(false)),
    );
    std::fs::write(fake.dir.path().join("master-dead"), "").unwrap();
    let read = host
        .run_read(&Command::new(["echo", "read"]))
        .await
        .unwrap();
    assert_eq!((read.code, read.stdout_text().as_str()), (0, "read\n"));
    let calls = fake.calls();
    assert_eq!(calls.len(), 2);
    assert!(calls[0].contains(&"-S".to_owned()));
    assert!(!calls[1].contains(&"-S".to_owned()));
    let write = host.run(&Command::new(["echo", "write"])).await.unwrap();
    assert_eq!(write.code, 255);
    let calls = fake.calls();
    assert_eq!(calls.len(), 3);
    assert!(calls[2].contains(&"-S".to_owned()));
}

#[tokio::test]
async fn a_posix_host_writes_reads_and_lists_files() {
    let fake = Fake::new();
    let host = fake.posix();
    let scratch = fake.scratch();
    let file = scratch.join("data 'one'.bin");
    let bytes: Vec<u8> = (0..=255u8).chain(*b"\n\0end").collect();
    host.write_file(&file, &bytes).await.unwrap();
    assert_eq!(std::fs::read(&file).unwrap(), bytes);
    host.write_file(&file, b"again").await.unwrap();
    assert_eq!(host.read_file(&file, 5).await.unwrap(), b"again");
    assert!(matches!(
        host.read_file(&file, 4).await,
        Err(HostError::TooLarge { limit: 4, .. })
    ));
    match host.read_file(&scratch.join("missing"), 10).await {
        Err(HostError::Io { source, .. }) => {
            assert_eq!(source.kind(), std::io::ErrorKind::NotFound)
        }
        other => panic!("{other:?}"),
    }
    // No temporary file is left beside it.
    std::fs::create_dir(scratch.join("sub")).unwrap();
    std::fs::write(scratch.join(".hidden"), "h").unwrap();
    std::os::unix::fs::symlink("sub", scratch.join("link")).unwrap();
    let entries = host.list(&scratch).await.unwrap();
    let seen: Vec<(&str, EntryKind, u64)> = entries
        .iter()
        .map(|entry| (entry.name.as_str(), entry.kind, entry.size))
        .collect();
    assert_eq!(
        seen,
        [
            (".hidden", EntryKind::File, 1),
            ("data 'one'.bin", EntryKind::File, 5),
            ("link", EntryKind::Symlink, 0),
            ("sub", EntryKind::Directory, 0),
        ]
    );
    assert!(entries.iter().all(|entry| entry.modified_ms.is_some()));
    assert!(host.list(&scratch.join("missing")).await.is_err());
}

#[tokio::test]
async fn a_stream_holds_a_session_and_a_hold_bridges_on_its_own_connection() {
    let fake = Fake::new();
    let host = fake.posix();
    let mut streamed = host
        .stream(&Command::new(["printf", "streamed"]))
        .await
        .unwrap();
    let mut text = String::new();
    streamed
        .stdout()
        .unwrap()
        .read_to_string(&mut text)
        .await
        .unwrap();
    assert_eq!(text, "streamed");
    assert_eq!(streamed.wait().await.unwrap(), 0);
    let _master = fake_master_with(&fake.sessions, "fake-host", Arc::new(AtomicBool::new(true)));
    let mut held = host.hold(&Command::new(["cat"])).await.unwrap();
    let mut stdin = held.stdin().unwrap();
    stdin.write_all(b"ping").await.unwrap();
    drop(stdin);
    let mut echoed = String::new();
    held.stdout()
        .unwrap()
        .read_to_string(&mut echoed)
        .await
        .unwrap();
    assert_eq!(echoed, "ping");
    assert_eq!(held.wait().await.unwrap(), 0);
    // The bridge never multiplexes, even with a master listening.
    assert!(!fake.calls().last().unwrap().contains(&"-S".to_owned()));
}

fn last_line(fake: &Fake) -> String {
    fake.calls().last().unwrap().last().unwrap().clone()
}

#[tokio::test]
async fn a_windows_host_runs_powershell_scripts() {
    let fake = Fake::new();
    let host = fake.windows("done\r\n");
    assert_eq!(host.kind(), HostKind::WindowsSsh("win-host".into()));
    assert_eq!(host.shell(), Shell::PowerShell);
    let output = host
        .run(
            &Command::new(["git", "status", "it's"])
                .cwd(r"C:\work dir")
                .env("A", "b")
                .env_remove("C"),
        )
        .await
        .unwrap();
    assert_eq!(output.stdout_text(), "done\r\n");
    let script = powershell_script(&last_line(&fake));
    assert!(
        script.contains(r"Set-Location -LiteralPath 'C:\work dir'"),
        "{script}"
    );
    assert!(
        script.contains("Set-Item -LiteralPath 'Env:A' -Value 'b'"),
        "{script}"
    );
    assert!(
        script.contains("Remove-Item -LiteralPath 'Env:C'"),
        "{script}"
    );
    assert!(
        script.contains("& 'git' 'status' 'it''s'\nexit $LASTEXITCODE"),
        "{script}"
    );
    // An empty environment cannot be asked of PowerShell.
    assert!(host.run(&Command::new(["x"]).env_clear()).await.is_err());
}

#[tokio::test]
async fn a_windows_host_moves_file_bytes_as_base64_and_lists_in_milliseconds() {
    let fake = Fake::new();
    let host = fake.windows("aGk=\r\n");
    let path = Path::new(r"C:\data\a.txt");
    assert_eq!(host.read_file(path, 10).await.unwrap(), b"hi");
    assert!(powershell_script(&last_line(&fake)).contains(r"[IO.File]::OpenRead('C:\data\a.txt')"));
    assert!(matches!(
        host.read_file(path, 1).await,
        Err(HostError::TooLarge { .. })
    ));
    host.write_file(path, b"\0bytes").await.unwrap();
    let sent = std::fs::read_to_string(fake.dir.path().join("stdin")).unwrap();
    assert_eq!(
        base64::engine::general_purpose::STANDARD
            .decode(sent)
            .unwrap(),
        b"\0bytes"
    );
    assert!(powershell_script(&last_line(&fake)).contains("Move-Item -LiteralPath $temporary"));
    let name = base64::engine::general_purpose::STANDARD.encode("b dir");
    let listing = format!(
        "file\t12\t1767323045678\t{}\r\ndirectory\t0\t1767323045000\t{name}\r\n",
        base64::engine::general_purpose::STANDARD.encode("a.txt")
    );
    std::fs::write(fake.dir.path().join("answer"), listing).unwrap();
    let entries = host.list(Path::new(r"C:\data")).await.unwrap();
    assert_eq!(entries.len(), 2);
    assert_eq!(
        (
            entries[0].name.as_str(),
            entries[0].kind,
            entries[0].size,
            entries[0].modified_ms
        ),
        ("a.txt", EntryKind::File, 12, Some(1_767_323_045_678))
    );
    assert_eq!(
        (entries[1].name.as_str(), entries[1].kind),
        ("b dir", EntryKind::Directory)
    );
    assert!(
        powershell_script(&last_line(&fake))
            .contains(r"Get-ChildItem -Force -LiteralPath 'C:\data'")
    );
    // A failure is the path's error.
    std::fs::write(fake.dir.path().join("code"), "1").unwrap();
    std::fs::write(fake.dir.path().join("answer"), "").unwrap();
    assert!(matches!(
        host.list(Path::new(r"C:\gone")).await,
        Err(HostError::Io { .. })
    ));
}
