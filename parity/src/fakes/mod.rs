//! The fakes of the plan's section 5.3.
//!
//! Command fakes are one binary (`parity-fake`) linked into the run's
//! `bin/` under every name below, so the server under test finds them
//! first on its PATH. Socket fakes run inside the harness: `herdr` (the
//! control and client sockets, on Herdr's own types), `http` (push
//! services, model downloads, an OpenAI-style endpoint, update mirrors).

pub mod agent_socket;
pub mod claude;
pub mod forge;
pub mod herdr;
pub mod herdr_panes;
pub mod http;
pub mod script;
pub mod ssh;
pub mod voice;

use std::io::Write;
use std::path::Path;
use std::time::Duration;

use script::Answer;

/// Every program the command fakes stand for, by fake.
pub const COMMAND_FAKES: &[(&str, &[&str])] = &[
    ("fake-ssh", &["ssh"]),
    ("fake-glab", &["glab"]),
    ("fake-gh", &["gh"]),
    ("fake-claude", &["claude"]),
    ("fake-voice-helper", &["roamgate-voice"]),
    ("fake-provider", &["time-report-provider"]),
    (
        "fake-svc",
        &[
            "systemctl",
            "journalctl",
            "launchctl",
            "schtasks",
            "powershell",
            "pwsh",
            "nvidia-smi",
            "rocm-smi",
            "system_profiler",
            "gamemoded",
            "host-spawn",
            "lsof",
            "ss",
            "ps",
            "xdg-open",
            "open",
            "explorer",
        ],
    ),
    ("fake-rsync", &["rsync"]),
    ("fake-ytdlp", &["yt-dlp"]),
    ("fake-herdr-cli", &["herdr"]),
];

/// Links the fake binary under every program name into `bin`.
pub fn install(fake: &Path, bin: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(bin)?;
    for (_, programs) in COMMAND_FAKES {
        for program in *programs {
            install_as(fake, &bin.join(exe(program)))?;
        }
    }
    Ok(())
}

pub fn exe(name: &str) -> String {
    if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_owned()
    }
}

/// The fake binary at `path` (a link, or a copy where links need rights).
pub fn install_as(fake: &Path, path: &Path) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let _ = std::fs::remove_file(path);
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(fake, path)
    }
    #[cfg(not(unix))]
    {
        std::fs::copy(fake, path).map(|_| ())
    }
}

/// Writes an answer's output and gives its exit code.
pub fn respond(answer: &Answer, base: &Path) -> i32 {
    if let Some(delay) = answer.delay_ms {
        std::thread::sleep(Duration::from_millis(delay));
    }
    for (path, content) in &answer.files {
        let path = base.join(path);
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let _ = std::fs::write(path, content);
    }
    let mut stdout = std::io::stdout();
    let _ = stdout.write_all(answer.stdout_text().as_bytes());
    let _ = stdout.flush();
    if let Some(text) = &answer.stderr {
        let _ = std::io::stderr().write_all(text.as_bytes());
    }
    answer.exit.unwrap_or(0)
}
