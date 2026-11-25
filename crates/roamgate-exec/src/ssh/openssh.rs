//! The command lines checked against real OpenSSH and real child processes
//! (bridge/ssh-openssh.test.ts): `ssh -G` for how OpenSSH resolves their
//! options, and a fake ssh for the cold retry and the session limit.

#[cfg(all(test, unix))]
mod tests {
    use std::collections::HashMap;
    use std::os::unix::fs::PermissionsExt;
    use std::path::{Path, PathBuf};
    use std::sync::Arc;
    use std::sync::atomic::AtomicBool;

    use crate::ssh::command::{SshCommand, ssh_master_argv};
    use crate::ssh::sessions::tests::{FakeMaster, fake_master_with, which};
    use crate::ssh::sessions::{
        MasterRegistration, SSH_SESSION_LIMIT, SessionError, SshOutput, SshSessionWait, SshSessions,
    };
    use roamgate_base::clock::SystemClock;

    fn sessions() -> SshSessions {
        SshSessions::with_platform(Arc::new(SystemClock), false)
    }

    /// OpenSSH's resolved options for argv, ignoring the user's config.
    fn resolved_options(argv: &[String]) -> HashMap<String, String> {
        let output = std::process::Command::new("ssh")
            .args(["-F", "/dev/null", "-G"])
            .args(&argv[1..])
            .stdin(std::process::Stdio::null())
            .output()
            .unwrap();
        assert_eq!(
            (
                output.status.code(),
                String::from_utf8_lossy(&output.stderr).into_owned()
            ),
            (Some(0), String::new())
        );
        String::from_utf8_lossy(&output.stdout)
            .lines()
            .filter_map(|line| line.split_once(' '))
            .map(|(key, value)| (key.to_owned(), value.to_owned()))
            .collect()
    }

    #[tokio::test]
    async fn a_cold_command_uses_no_control_socket() {
        if which("ssh").is_none() {
            return;
        }
        let command = sessions()
            .command_argv("dev-box", "true", &[], None)
            .unwrap();
        let options = resolved_options(&command.argv);
        // ssh -G omits ControlPath when it is none.
        assert!(!options.contains_key("controlpath"));
        assert_eq!(options["controlmaster"], "false");
        assert_eq!(options["batchmode"], "yes");
    }

    #[tokio::test]
    async fn s_overrides_the_control_path_none_policy_for_a_multiplexed_command() {
        if which("ssh").is_none() {
            return;
        }
        let sessions = sessions();
        let directory = tempfile::tempdir_in(roamgate_base::paths::short_temp_root()).unwrap();
        let control_path = directory
            .path()
            .join("m.ctl")
            .to_string_lossy()
            .into_owned();
        std::fs::write(&control_path, "").unwrap();
        let owner = sessions.new_owner();
        sessions.register_master(
            owner,
            MasterRegistration {
                destination: "dev-box".into(),
                control_path: control_path.clone(),
                is_listening: Arc::new(|| true),
                is_alive: Arc::new(|| Box::pin(async { true })),
                recycle: None,
            },
        );
        let command = sessions.command_argv("dev-box", "true", &[], None).unwrap();
        assert!(command.contains("-S"));
        let options = resolved_options(&command.argv);
        assert_eq!(options["controlpath"], control_path);
        // A client of the master, never a master itself.
        assert_eq!(options["controlmaster"], "false");
        assert_eq!(options["controlpersist"], "no");
    }

    #[tokio::test]
    async fn m_makes_the_master_argv_a_master_despite_control_master_no() {
        if which("ssh").is_none() {
            return;
        }
        let directory = tempfile::tempdir_in(roamgate_base::paths::short_temp_root()).unwrap();
        let control_path = directory
            .path()
            .join("m.ctl")
            .to_string_lossy()
            .into_owned();
        let options = resolved_options(&ssh_master_argv("dev-box", &control_path).unwrap());
        assert_eq!(options["controlmaster"], "true");
        assert_eq!(options["controlpath"], control_path);
    }

    // Logs each run as "start|end <mux|cold> <command>". As sshd does, it
    // hands the remote line to a shell; the commands sent (cat, rm, hold)
    // are fakes on that shell's PATH. "hold" waits for the release file. A
    // multiplexed run exits 255 with nothing on stderr once the dead-master
    // marker exists, as a mux client whose master went away does.
    const FAKE_SSH: &str = r#"#!/bin/sh
mode=cold
last=
for arg in "$@"; do
  [ "$arg" = "-S" ] && mode=mux
  last="$arg"
done
setsid=; command -v setsid >/dev/null && setsid=setsid
PATH="$(dirname "$0")/remote:$PATH" FAKE_SSH_MODE=$mode exec $setsid sh -c "$last"
"#;
    const FAKE_REMOTE_SHELL: &str = r#"#!/bin/sh
mode=$FAKE_SSH_MODE
command=$2
echo "start $mode $command" >> "$FAKE_SSH_LOG"
if [ "$command" = hold ]; then
  while [ ! -e "$FAKE_SSH_RELEASE" ]; do sleep 0.02; done
fi
echo "end $mode $command" >> "$FAKE_SSH_LOG"
if [ "$mode" = mux ] && [ -e "$FAKE_SSH_MASTER_DEAD" ]; then exit 255; fi
echo "ran $mode"
"#;

    #[derive(Debug, Clone, PartialEq, Eq)]
    struct Ran {
        code: i32,
        stdout: String,
        stderr: String,
    }

    impl SshOutput for Ran {
        fn code(&self) -> i32 {
            self.code
        }
        fn stderr(&self) -> &str {
            &self.stderr
        }
        fn set_stderr(&mut self, stderr: String) {
            self.stderr = stderr;
        }
    }

    fn executable(path: &Path, text: &str) {
        std::fs::write(path, text).unwrap();
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
    }

    struct FakeSsh {
        _directory: tempfile::TempDir,
        bin: PathBuf,
        log: PathBuf,
        release: PathBuf,
        master_dead: PathBuf,
    }

    impl FakeSsh {
        fn new() -> Self {
            let directory = tempfile::Builder::new()
                .prefix("rg-openssh-test-")
                .tempdir_in(roamgate_base::paths::short_temp_root())
                .unwrap();
            let bin = directory.path().join("bin");
            std::fs::create_dir_all(bin.join("remote")).unwrap();
            executable(&bin.join("ssh"), FAKE_SSH);
            executable(&bin.join("remote-shell"), FAKE_REMOTE_SHELL);
            for name in ["cat", "rm", "hold"] {
                executable(
                    &bin.join("remote").join(name),
                    &format!(
                        "#!/bin/sh\nexec '{}' -c {name}\n",
                        bin.join("remote-shell").display()
                    ),
                );
            }
            let log = directory.path().join("ssh.log");
            std::fs::write(&log, "").unwrap();
            Self {
                bin,
                log,
                release: directory.path().join("release"),
                master_dead: directory.path().join("master-dead"),
                _directory: directory,
            }
        }

        fn log(&self) -> Vec<String> {
            std::fs::read_to_string(&self.log)
                .unwrap()
                .lines()
                .filter(|line| !line.is_empty())
                .map(str::to_owned)
                .collect()
        }

        /// A dead master registered for dev-box, as the TS driver does; kept
        /// registered while the returned guard lives.
        fn dead_master(&self, sessions: &SshSessions) -> FakeMaster {
            std::fs::write(&self.master_dead, "").unwrap();
            fake_master_with(sessions, "dev-box", Arc::new(AtomicBool::new(false)))
        }

        /// Runs a command as the process runner does, with the fake first on
        /// PATH, inside the session limit.
        async fn run(
            &self,
            sessions: &SshSessions,
            command: &SshCommand,
            timeout_ms: u64,
        ) -> Result<Ran, SessionError> {
            let path = format!(
                "{}:{}",
                self.bin.display(),
                std::env::var("PATH").unwrap_or_default()
            );
            sessions
                .run(
                    command,
                    |attempt, _| {
                        let path = path.clone();
                        async move {
                            let output = tokio::process::Command::new(self.bin.join("ssh"))
                                .args(&attempt.argv[1..])
                                .env("PATH", path)
                                .env("FAKE_SSH_LOG", &self.log)
                                .env("FAKE_SSH_RELEASE", &self.release)
                                .env("FAKE_SSH_MASTER_DEAD", &self.master_dead)
                                .stdin(std::process::Stdio::null())
                                .output()
                                .await
                                .unwrap();
                            Ok(Ran {
                                code: output.status.code().unwrap_or(-1),
                                stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
                                stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
                            })
                        }
                    },
                    &SshSessionWait::timeout(timeout_ms),
                )
                .await
        }
    }

    #[tokio::test]
    async fn a_read_whose_master_died_reruns_once_cold() {
        let fake = FakeSsh::new();
        let sessions = sessions();
        let _master = fake.dead_master(&sessions);
        let command = sessions
            .read_command_argv("dev-box", "cat", &[], None)
            .unwrap();
        let ran = fake.run(&sessions, &command, 5000).await.unwrap();
        assert_eq!((ran.code, ran.stdout.as_str()), (0, "ran cold\n"));
        assert_eq!(
            fake.log(),
            [
                "start mux cat",
                "end mux cat",
                "start cold cat",
                "end cold cat"
            ]
        );
    }

    #[tokio::test]
    async fn a_write_whose_master_died_reports_255_and_never_runs_twice() {
        let fake = FakeSsh::new();
        let sessions = sessions();
        let _master = fake.dead_master(&sessions);
        let command = sessions.command_argv("dev-box", "rm", &[], None).unwrap();
        let ran = fake.run(&sessions, &command, 5000).await.unwrap();
        assert_eq!((ran.code, ran.stdout.as_str()), (255, ""));
        assert_eq!(fake.log(), ["start mux rm", "end mux rm"]);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn runs_at_most_ssh_session_limit_ssh_processes_per_destination() {
        let fake = Arc::new(FakeSsh::new());
        let sessions = sessions();
        let runs: Vec<_> = (0..SSH_SESSION_LIMIT + 2)
            .map(|_| {
                let fake = fake.clone();
                let sessions = sessions.clone();
                tokio::spawn(async move {
                    let command = sessions.command_argv("dev-box", "hold", &[], None).unwrap();
                    fake.run(&sessions, &command, 20_000).await
                })
            })
            .collect();
        let starts = |fake: &FakeSsh| {
            fake.log()
                .iter()
                .filter(|line| line.starts_with("start"))
                .count()
        };
        let clock = SystemClock;
        for _ in 0..500 {
            if starts(&fake) >= SSH_SESSION_LIMIT {
                break;
            }
            roamgate_base::clock::Clock::sleep(&clock, std::time::Duration::from_millis(10)).await;
        }
        assert_eq!(starts(&fake), SSH_SESSION_LIMIT);
        // Give a ninth process the chance to start if the limit leaked.
        roamgate_base::clock::Clock::sleep(&clock, std::time::Duration::from_millis(300)).await;
        assert_eq!(starts(&fake), SSH_SESSION_LIMIT);
        std::fs::write(&fake.release, "").unwrap();
        for run in runs {
            assert_eq!(run.await.unwrap().unwrap().code, 0);
        }
        let mut live = 0i32;
        let mut most = 0;
        for line in fake.log() {
            live += if line.starts_with("start") { 1 } else { -1 };
            most = most.max(live);
        }
        assert_eq!(most, SSH_SESSION_LIMIT as i32);
    }
}
