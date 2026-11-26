//! An Antigravity (`agy`) account's sign-in, as `agy` itself reports it.
//! Roamgate never reads, writes or sends an `agy` token: the user signs
//! in inside `agy`, started on the account (a session on its profile), and
//! Roamgate only asks `agy models`, in the account's environment, whether
//! that works. The answer is kept in `<dir>/.roamgate/agy-auth.json`.

use std::path::Path;
use std::time::Duration;

use serde_json::{Map, Value, json};

use crate::files::{read_object, state_dir, state_file, write_private};
use crate::{AccountAgent, AuthState, launch_env};

const CHECK_TIMEOUT: Duration = Duration::from_secs(60);

/// What `agy models` says when it is not signed in.
fn asks_to_sign_in(output: &str) -> bool {
    let output = output.to_lowercase();
    [
        "sign in",
        "signin",
        "log in",
        "login",
        "not authenticated",
        "unauthenticated",
    ]
    .iter()
    .any(|words| output.contains(words))
}

/// Runs `<program> models` in the account's environment and records
/// whether it works.
pub async fn check(program: &str, dir: &Path, now_ms: i64) -> AuthState {
    let env = launch_env(AccountAgent::Agy, dir);
    let mut command = tokio::process::Command::new(program);
    command
        .arg("models")
        .stdin(std::process::Stdio::null())
        .kill_on_drop(true);
    for name in &env.unset {
        command.env_remove(name);
    }
    for (name, value) in &env.set {
        command.env(name, value);
    }
    let state = match tokio::time::timeout(CHECK_TIMEOUT, command.output()).await {
        Ok(Ok(output)) => {
            let text = format!(
                "{}\n{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
            if output.status.success() && !asks_to_sign_in(&text) {
                AuthState::SignedIn
            } else {
                AuthState::SignedOut
            }
        }
        _ => AuthState::Unknown,
    };
    if let Ok(path) = state_file(dir, "agy-auth.json") {
        let mut record = Map::new();
        record.insert("state".into(), json!(state.as_str()));
        record.insert("at".into(), json!(roamgate_base::log::iso_millis(now_ms)));
        let _ = write_private(&path, &record);
    }
    state
}

/// The last [`check`]'s answer, else unknown.
pub fn auth_state(dir: &Path) -> AuthState {
    match read_object(&state_dir(dir).join("agy-auth.json"))
        .and_then(|record| {
            record
                .get("state")
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .as_deref()
    {
        Some("signed_in") => AuthState::SignedIn,
        Some("signed_out") => AuthState::SignedOut,
        _ => AuthState::Unknown,
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    /// A fake `agy` that is signed in when its home has a marker.
    fn fake_agy(dir: &Path) -> String {
        let path = dir.join("agy");
        std::fs::write(
            &path,
            "#!/bin/sh\nif [ -f \"$HOME/signed\" ] && [ \"$1\" = models ]; then echo gemini-3; else echo 'Please sign in'; exit 1; fi\n",
        )
        .unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        path.to_string_lossy().into_owned()
    }

    #[tokio::test]
    async fn agy_itself_says_whether_the_account_is_signed_in() {
        let temp = tempfile::tempdir().unwrap();
        let program = fake_agy(temp.path());
        let dir = temp.path().join("acct");
        std::fs::create_dir_all(crate::agy_home(&dir)).unwrap();
        assert_eq!(auth_state(&dir), AuthState::Unknown);
        assert_eq!(check(&program, &dir, 0).await, AuthState::SignedOut);
        assert_eq!(auth_state(&dir), AuthState::SignedOut);
        std::fs::write(crate::agy_home(&dir).join("signed"), "").unwrap();
        assert_eq!(check(&program, &dir, 0).await, AuthState::SignedIn);
        assert_eq!(auth_state(&dir), AuthState::SignedIn);
        assert_eq!(check("/nonexistent/agy", &dir, 0).await, AuthState::Unknown);
    }
}
