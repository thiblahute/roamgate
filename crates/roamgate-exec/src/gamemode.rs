//! Whether GameMode (gamemoded) runs (utils/gamemode.ts): a game has the
//! machine, so heavy background work (voice models, the archive's text
//! repo, history passes) yields to it.

use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use crate::process::{Command, KillSignal, ProcessRunner};

/// How long `gamemoded -s` may take.
pub const GAME_MODE_TIMEOUT: Duration = Duration::from_millis(3000);

/// `gamemoded -s`'s answer: Some(true) active, Some(false) inactive, None
/// unknown.
pub fn parse_game_mode(output: &str) -> Option<bool> {
    let lower = output.to_ascii_lowercase();
    if lower.contains("gamemode is active") {
        Some(true)
    } else if lower.contains("gamemode is inactive") {
        Some(false)
    } else {
        None
    }
}

/// The command asking GameMode whether it runs: on the host through
/// `host_spawn` when the server runs in a toolbox (gamemoded is the
/// host's); None in a toolbox without a runnable host-spawn.
pub fn game_mode_command(in_toolbox: bool, host_spawn: Option<&Path>) -> Option<Vec<String>> {
    if !in_toolbox {
        return Some(vec!["gamemoded".into(), "-s".into()]);
    }
    host_spawn.map(|path| {
        vec![
            path.display().to_string(),
            "--no-pty".into(),
            "gamemoded".into(),
            "-s".into(),
        ]
    })
}

/// Whether this process runs in a toolbox (or another podman container).
pub fn in_toolbox() -> bool {
    Path::new("/run/.toolboxenv").exists()
}

/// The command for this process: in a toolbox, through the host-spawn
/// that runs.
pub fn default_game_mode_command() -> Option<Vec<String>> {
    let toolbox = in_toolbox();
    let host_spawn = if toolbox {
        crate::host_spawn::find_host_spawn()
    } else {
        None
    };
    game_mode_command(toolbox, host_spawn.as_deref())
}

static UNAVAILABLE_LOGGED: AtomicBool = AtomicBool::new(false);

/// Why GameMode cannot be asked, logged once per process at debug.
fn unavailable(reason: &str, detail: &str) -> Option<bool> {
    if !UNAVAILABLE_LOGGED.swap(true, Ordering::Relaxed) {
        tracing::debug!(target: "voice", detail, "GameMode detection unavailable: {reason}");
    }
    None
}

/// Whether GameMode runs now; None when it cannot tell (not Linux, none
/// installed, no answer).
pub async fn game_mode_active(
    runner: &ProcessRunner,
    command: Option<Vec<String>>,
    timeout: Duration,
) -> Option<bool> {
    if !cfg!(target_os = "linux") {
        return None;
    }
    let Some(argv) = command else {
        return unavailable(
            "in a toolbox without a runnable host-spawn",
            &std::env::var("PATH").unwrap_or_default(),
        );
    };
    let joined = argv.join(" ");
    let run = Command::new(argv)
        .timeout(timeout)
        .kill_signal(KillSignal::Term);
    match runner.run(&run).await {
        Ok(output) => {
            let text = format!("{}\n{}", output.stdout_text(), output.stderr_text());
            match parse_game_mode(&text) {
                Some(active) => Some(active),
                None => unavailable(
                    "no GameMode answer",
                    &format!("{joined} (code {}): {}", output.code, text.trim()),
                ),
            }
        }
        Err(error) => unavailable("the command did not run", &format!("{joined}: {error}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gamemoded_s_answer() {
        assert_eq!(parse_game_mode("gamemode is active\n"), Some(true));
        assert_eq!(parse_game_mode("gamemode is inactive\n"), Some(false));
        assert_eq!(parse_game_mode(""), None);
        assert_eq!(parse_game_mode("sh: gamemoded: command not found"), None);
    }

    #[test]
    fn asked_on_the_host_from_a_toolbox() {
        assert_eq!(
            game_mode_command(true, Some(Path::new("/usr/bin/host-spawn"))),
            Some(vec![
                "/usr/bin/host-spawn".to_owned(),
                "--no-pty".into(),
                "gamemoded".into(),
                "-s".into()
            ])
        );
        assert_eq!(game_mode_command(true, None), None);
        assert_eq!(
            game_mode_command(false, None),
            Some(vec!["gamemoded".to_owned(), "-s".into()])
        );
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn through_the_host_spawn_that_runs_past_a_broken_one_on_path() {
        use crate::host_spawn::{host_spawn_path, tests::put};
        let root = tempfile::tempdir().unwrap();
        let broken = put(root.path(), "broken", 0o644, "");
        let real = put(
            root.path(),
            "real",
            0o755,
            "#!/bin/sh\n[ \"$*\" = \"--no-pty gamemoded -s\" ] && echo \"gamemode is active\"\n",
        );
        let path = format!(
            "{}:{}",
            root.path().join("broken").display(),
            root.path().join("real").display()
        );
        let host_spawn = host_spawn_path(&path, &[], None);
        assert_eq!(host_spawn.as_deref(), Some(real.as_path()));
        let runner = ProcessRunner::system();
        assert_eq!(
            game_mode_active(
                &runner,
                game_mode_command(true, host_spawn.as_deref()),
                GAME_MODE_TIMEOUT
            )
            .await,
            Some(true)
        );
        // The broken one alone: no answer, not a spawn error.
        assert_eq!(
            host_spawn_path(&root.path().join("broken").display().to_string(), &[], None),
            None
        );
        assert_eq!(
            game_mode_active(&runner, game_mode_command(true, None), GAME_MODE_TIMEOUT).await,
            None
        );
        assert_eq!(
            game_mode_active(
                &runner,
                Some(vec![broken.display().to_string(), "gamemoded".into()]),
                GAME_MODE_TIMEOUT
            )
            .await,
            None
        );
    }
}
