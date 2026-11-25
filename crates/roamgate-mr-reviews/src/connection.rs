//! A connection the reviews module works on (`MrConnection` of
//! `mr-reviews/clones.ts`): a POSIX shell script on its host, the folders
//! of its workspaces and panes, and Herdr calls. In the core, these go to
//! Bun through reverse calls (`host.run`, `herdr.call`) until the host
//! layer is Rust's (S16). A profile's launch token and conversation mode's
//! hold on a pane are Bun's too: `launch` and the `conversation_*` members
//! default to "not here", as a connection without them in Bun.

use std::future::Future;
use std::pin::Pin;

use serde_json::{Map, Value, json};

pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// What a script gave.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ShellResult {
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
}

/// What a profile's agent starts with (`LaunchSpec` of profiles.ts).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct LaunchSpec {
    pub argv: Vec<String>,
    pub env: Vec<(String, String)>,
    pub unset: Vec<String>,
    pub agent: String,
    /// Set ROAMGATE_CLAUDE_START=terminal (the agent stays in the terminal).
    pub terminal: bool,
}

impl LaunchSpec {
    /// The spec as Bun builds it, keys in its order.
    pub fn to_json(&self) -> Value {
        let env: Map<String, Value> = self
            .env
            .iter()
            .map(|(name, value)| (name.clone(), Value::String(value.clone())))
            .collect();
        json!({
            "argv": self.argv, "env": env, "unset": self.unset,
            "agent": self.agent, "terminal": self.terminal,
        })
    }
}

/// What conversation mode's own switch gave.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SwitchResult {
    Ok,
    Refused { busy: bool, reason: String },
}

pub trait MrConnection: Send + Sync {
    fn id(&self) -> &str;
    fn label(&self) -> &str;
    /// A POSIX shell script on the connection's host.
    fn run<'a>(&'a self, script: &'a str, timeout_ms: u64) -> BoxFuture<'a, ShellResult>;
    /// Directories of its workspaces and panes.
    fn dirs(&self) -> BoxFuture<'_, Vec<String>> {
        Box::pin(async { Vec::new() })
    }
    /// A Herdr call on the connection.
    fn herdr<'a>(&'a self, method: &'a str, params: Value) -> BoxFuture<'a, Result<Value, String>> {
        let _ = (method, params);
        Box::pin(async { Err("no Herdr here".to_owned()) })
    }
    /// Whether [`MrConnection::launch`] is there (`conn.launch` set).
    fn can_launch(&self) -> bool {
        false
    }
    /// What to type into a pane to start a profile's agent (a one-use
    /// token roamgate-hold trades for the program and environment).
    fn launch<'a>(
        &'a self,
        pane_id: &'a str,
        spec: LaunchSpec,
    ) -> BoxFuture<'a, Result<String, String>> {
        let _ = (pane_id, spec);
        Box::pin(async { Err("no profile launch here".to_owned()) })
    }
    /// The session conversation mode holds the pane on, if it runs on the
    /// connection and holds it.
    fn conversation_owned<'a>(&'a self, pane_id: &'a str) -> BoxFuture<'a, Option<String>> {
        let _ = pane_id;
        Box::pin(async { None })
    }
    /// Conversation mode's own switch: the idle process stops, the other
    /// session starts. Only asked of a pane it holds.
    fn conversation_switch<'a>(
        &'a self,
        pane_id: &'a str,
        session_id: &'a str,
    ) -> BoxFuture<'a, SwitchResult> {
        let _ = (pane_id, session_id);
        Box::pin(async {
            SwitchResult::Refused {
                busy: false,
                reason: "no conversation mode here".to_owned(),
            }
        })
    }
    /// A prompt for the session conversation mode holds in the pane;
    /// false: it holds none (or has no prompt).
    fn conversation_prompt<'a>(
        &'a self,
        pane_id: &'a str,
        text: &'a str,
    ) -> BoxFuture<'a, Result<bool, String>> {
        let _ = (pane_id, text);
        Box::pin(async { Ok(false) })
    }
}

/// POSIX quoting, as `shQuote`.
pub fn sh_quote(value: &str) -> String {
    roamgate_exec::quote::shell_quote(value)
}

#[cfg(test)]
pub mod fixture {
    //! Git repositories for tests (`mr-reviews/git.fixture.ts`): a "forge"
    //! of bare repositories reached through an https URL, clones, and a
    //! connection running scripts here as a Herdr connection would.

    use std::path::{Path, PathBuf};
    use std::process::{Command, Stdio};
    use std::sync::Mutex;
    use std::sync::atomic::{AtomicI64, Ordering};

    use serde_json::{Value, json};

    use super::{BoxFuture, MrConnection, ShellResult};

    pub const FORGE_HOST: &str = "gitlab.example.org";

    pub struct GitFixture {
        _dir: tempfile::TempDir,
        pub root: PathBuf,
        home: PathBuf,
        clock: AtomicI64,
    }

    pub struct Workspace {
        pub workspace_id: String,
        pub label: String,
        pub cwd: String,
    }

    pub struct LocalConnection {
        pub id: String,
        pub label: String,
        home: PathBuf,
        pub scripts: Mutex<Vec<String>>,
        workspaces: Vec<Workspace>,
    }

    impl LocalConnection {
        pub fn script_count(&self) -> usize {
            self.scripts.lock().unwrap().len()
        }
    }

    impl MrConnection for LocalConnection {
        fn id(&self) -> &str {
            &self.id
        }
        fn label(&self) -> &str {
            &self.label
        }
        fn run<'a>(&'a self, script: &'a str, _timeout_ms: u64) -> BoxFuture<'a, ShellResult> {
            self.scripts.lock().unwrap().push(script.to_owned());
            let output = Command::new("sh")
                .arg("-c")
                .arg(script)
                .env("HOME", &self.home)
                .env("GIT_CONFIG_NOSYSTEM", "1")
                .env("GIT_AUTHOR_DATE", "2026-01-01T00:00:00Z")
                .env("GIT_COMMITTER_DATE", "2026-01-01T00:00:00Z")
                .stdin(Stdio::null())
                .output()
                .expect("sh");
            let result = ShellResult {
                code: output.status.code().unwrap_or(-1),
                stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
                stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
            };
            Box::pin(async move { result })
        }
        fn dirs(&self) -> BoxFuture<'_, Vec<String>> {
            let dirs = self.workspaces.iter().map(|w| w.cwd.clone()).collect();
            Box::pin(async move { dirs })
        }
        fn herdr<'a>(
            &'a self,
            method: &'a str,
            _params: Value,
        ) -> BoxFuture<'a, Result<Value, String>> {
            let answer = if method == "workspace.list" {
                json!({"workspaces": self.workspaces.iter().map(|w| json!({"workspace_id": w.workspace_id, "label": w.label})).collect::<Vec<_>>()})
            } else {
                json!({"panes": self.workspaces.iter().map(|w| json!({"pane_id": format!("{}:p1", w.workspace_id), "workspace_id": w.workspace_id, "cwd": w.cwd})).collect::<Vec<_>>()})
            };
            Box::pin(async move { Ok(answer) })
        }
    }

    impl GitFixture {
        #[allow(clippy::new_without_default)]
        pub fn new() -> GitFixture {
            let dir = tempfile::Builder::new()
                .prefix("rg-git-")
                .tempdir_in(roamgate_base::paths::short_temp_root())
                .unwrap();
            let root = crate::worktree::tests::git_form(dir.path());
            let home = root.join("home");
            std::fs::create_dir(&home).unwrap();
            // file:///C:/x on Windows, file:///x elsewhere.
            let forge = root.display().to_string();
            let slash = if forge.starts_with('/') { "" } else { "/" };
            std::fs::write(
                home.join(".gitconfig"),
                format!(
                    "[user]\n\tname = Test\n\temail = test@example.org\n[url \"file://{slash}{forge}/forge/\"]\n\tinsteadOf = https://{FORGE_HOST}/\n[init]\n\tdefaultBranch = main\n[advice]\n\tdetachedHead = false\n"
                ),
            )
            .unwrap();
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_secs() as i64;
            GitFixture {
                _dir: dir,
                root,
                home,
                clock: AtomicI64::new(now - 86_400),
            }
        }

        fn command(&self, dir: &Path, args: &[&str]) -> Command {
            let mut command = Command::new("git");
            command
                .arg("-C")
                .arg(dir)
                .args(args)
                .env("HOME", &self.home)
                .env("GIT_CONFIG_NOSYSTEM", "1")
                .env("GIT_AUTHOR_DATE", "2026-01-01T00:00:00Z")
                .env("GIT_COMMITTER_DATE", "2026-01-01T00:00:00Z")
                .stdin(Stdio::null());
            command
        }

        /// git in a directory; panics on failure, gives stdout.
        pub fn git(&self, dir: &Path, args: &[&str]) -> String {
            let output = self.command(dir, args).output().unwrap();
            assert!(
                output.status.success(),
                "git {args:?}: {}",
                String::from_utf8_lossy(&output.stderr)
            );
            String::from_utf8_lossy(&output.stdout).into_owned()
        }

        /// git with stdin.
        pub fn git_input(&self, dir: &Path, args: &[&str], input: &[u8]) {
            use std::io::Write;
            let mut child = self
                .command(dir, args)
                .stdin(Stdio::piped())
                .spawn()
                .unwrap();
            child.stdin.take().unwrap().write_all(input).unwrap();
            assert!(child.wait().unwrap().success(), "git {args:?}");
        }

        pub fn commit(
            &self,
            dir: &Path,
            file: &str,
            content: &str,
            message: &str,
            at: Option<i64>,
        ) -> String {
            let path = dir.join(file);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(&path, content).unwrap();
            self.git(dir, &["add", file]);
            let when = format!(
                "@{} +0000",
                at.unwrap_or_else(|| self.clock.fetch_add(60, Ordering::SeqCst) + 60)
            );
            let output = self
                .command(dir, &["commit", "-q", "-m", message])
                .env("GIT_AUTHOR_DATE", &when)
                .env("GIT_COMMITTER_DATE", &when)
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "commit: {}",
                String::from_utf8_lossy(&output.stderr)
            );
            self.git(dir, &["rev-parse", "HEAD"]).trim().to_owned()
        }

        /// A bare project on the forge, with a first commit on main.
        pub fn project(&self, path: &str) -> PathBuf {
            let bare = self.root.join("forge").join(format!("{path}.git"));
            std::fs::create_dir_all(&bare).unwrap();
            self.git(&bare, &["init", "-q", "--bare"]);
            let seed = self.root.join("seed").join(path);
            std::fs::create_dir_all(&seed).unwrap();
            self.git(&seed, &["init", "-q"]);
            self.commit(&seed, "README", "hello\n", "Start", None);
            self.git(&seed, &["push", "-q", bare.to_str().unwrap(), "main"]);
            bare
        }

        /// A clone of a forge project, its origin the project's https URL.
        pub fn clone(&self, path: &str, name: &str) -> PathBuf {
            let dir = self.root.join("clones").join(name);
            std::fs::create_dir_all(dir.parent().unwrap()).unwrap();
            let output = self
                .command(
                    &self.root,
                    &[
                        "clone",
                        "-q",
                        &format!("https://{FORGE_HOST}/{path}.git"),
                        dir.to_str().unwrap(),
                    ],
                )
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "clone: {}",
                String::from_utf8_lossy(&output.stderr)
            );
            self.git(&dir, &["remote", "set-head", "origin", "main"]);
            dir
        }

        pub fn connection(&self, workspaces: Vec<Workspace>, id: &str) -> LocalConnection {
            LocalConnection {
                id: id.into(),
                label: if id == "local" {
                    "Desktop".into()
                } else {
                    id.into()
                },
                home: self.home.clone(),
                scripts: Mutex::new(vec![]),
                workspaces,
            }
        }
    }
}
