//! A host refusing sessions past sshd's MaxSessions, with real child
//! processes (bridge/ssh-refused.test.ts): refused multiplexed commands wait
//! and run over the master again, never logging in on their own.

#[cfg(all(test, unix))]
mod tests {
    use std::os::unix::fs::PermissionsExt;
    use std::sync::Arc;

    use crate::ssh::sessions::tests::fake_master_with;
    use crate::ssh::sessions::{SessionError, SshOutput, SshSessionWait, SshSessions};
    use roamgate_base::clock::SystemClock;
    use std::sync::atomic::AtomicBool;

    /// A fake `ssh` for a host with sshd's MaxSessions at `FAKE_SSH_MAX`: a
    /// multiplexed command past it is refused as OpenSSH reports it, then
    /// falls back to a login of its own unless its ProxyCommand fails; a
    /// session stays open on the host a moment after its client exits.
    const FAKE_SSH: &str = r#"#!/bin/sh
state="$FAKE_SSH_STATE"
mux=0; muxonly=0
for a in "$@"; do
  [ "$a" = -S ] && mux=1
  [ "$a" = ProxyCommand=false ] && muxonly=1
done
cold() { echo x >> "$state/cold"; sleep 0.05; echo out; exit 0; }
[ $mux = 1 ] || cold
i=0; slot=
while [ $i -lt "$FAKE_SSH_MAX" ]; do
  if mkdir "$state/s$i" 2>/dev/null; then slot="$state/s$i"; break; fi
  i=$((i+1))
done
if [ -z "$slot" ]; then
  echo x >> "$state/refused"
  echo "mux_client_request_session: session request failed: Session open refused by peer" >&2
  [ $muxonly = 1 ] || cold
  echo "kex_exchange_identification: Connection closed by remote host" >&2
  exit 255
fi
sleep 0.05
echo out
(sleep 0.1; rmdir "$slot") >/dev/null 2>&1 &
exit 0
"#;

    #[derive(Debug)]
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

    fn count(state: &std::path::Path, name: &str) -> usize {
        std::fs::read_to_string(state.join(name))
            .map(|text| text.lines().filter(|line| !line.is_empty()).count())
            .unwrap_or(0)
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn commands_a_host_refuses_past_its_sessions_wait_and_run_over_the_master() {
        let directory = tempfile::Builder::new()
            .prefix("rg-ssh-refused-")
            .tempdir_in("/tmp")
            .unwrap();
        let bin = directory.path().join("bin");
        let state = directory.path().join("state");
        std::fs::create_dir_all(&bin).unwrap();
        std::fs::create_dir_all(&state).unwrap();
        let ssh = bin.join("ssh");
        std::fs::write(&ssh, FAKE_SSH).unwrap();
        std::fs::set_permissions(&ssh, std::fs::Permissions::from_mode(0o755)).unwrap();
        let sessions = SshSessions::with_platform(Arc::new(SystemClock), false);
        let _master = fake_master_with(&sessions, "refusing-host", Arc::new(AtomicBool::new(true)));
        let runs: Vec<_> = (0..16)
            .map(|index| {
                let sessions = sessions.clone();
                let ssh = ssh.clone();
                let state = state.clone();
                tokio::spawn(async move {
                    let command = sessions
                        .read_command_argv("refusing-host", &format!("read {index}"), &[], None)
                        .unwrap();
                    sessions
                        .run(
                            &command,
                            |attempt, _| {
                                assert_eq!(attempt.argv[0], "ssh");
                                let ssh = ssh.clone();
                                let state = state.clone();
                                async move {
                                    let output = tokio::process::Command::new(&ssh)
                                        .args(&attempt.argv[1..])
                                        .env_clear()
                                        .env(
                                            "PATH",
                                            std::env::var("PATH")
                                                .unwrap_or_else(|_| "/usr/bin:/bin".into()),
                                        )
                                        .env("FAKE_SSH_STATE", &state)
                                        .env("FAKE_SSH_MAX", "3")
                                        .stdin(std::process::Stdio::null())
                                        .output()
                                        .await
                                        .unwrap();
                                    Ok::<_, SessionError>(Ran {
                                        code: output.status.code().unwrap_or(-1),
                                        stdout: String::from_utf8_lossy(&output.stdout)
                                            .into_owned(),
                                        stderr: String::from_utf8_lossy(&output.stderr)
                                            .into_owned(),
                                    })
                                }
                            },
                            &SshSessionWait::default(),
                        )
                        .await
                })
            })
            .collect();
        for run in runs {
            let ran = run.await.unwrap().unwrap();
            assert_eq!(ran.code, 0);
            assert_eq!(ran.stdout, "out\n");
            assert_eq!(ran.stderr, "");
        }
        // The host refused some (8 slots here, 3 sessions there): each
        // waited and ran over the master again, never logging in on its own.
        assert!(count(&state, "refused") > 0);
        assert_eq!(count(&state, "cold"), 0);
    }
}
