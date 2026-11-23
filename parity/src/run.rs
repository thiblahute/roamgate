//! One run: a server under test in a directory of its own.
//!
//! The server gets nothing of the caller's environment but PATH (with the
//! run's fakes first): its own HOME, XDG directories, APPDATA, TMPDIR and
//! data root under the run's root, its own fake Herdr, the test clock, and
//! record mode. `ROAMGATE_SERVER_CMD` names the server (default: the Bun
//! server from this checkout); `ROAMGATE_SERVER_CWD` its working directory.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::{Context, Result, anyhow, bail};
use regex::Regex;
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::oneshot;

use crate::clock::Clock;
use crate::fakes::herdr::{FakeHerdr, HerdrSeed};
use crate::fakes::http::FakeHttp;
use crate::fakes::{self, script};
use crate::normalize::RunPaths;
use crate::paths::repo_root;

/// 2026-01-01T00:00:00Z: where the test clock starts unless told.
pub const DEFAULT_EPOCH_MS: i64 = 1_767_225_600_000;

/// The login password every run uses unless told (long enough for no
/// warning).
pub const PASSWORD: &str = "parity-password-0123456789";

/// The variables every run gives the server (besides the scenario's).
pub const HARNESS_ENV: &[&str] = &[
    "PATH",
    "HOME",
    "USERPROFILE",
    "APPDATA",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "NODE_ENV",
    "HOST",
    "PORT",
    "OPEN_BROWSER",
    "ROAMGATE_PIN",
    "ROAMGATE_TLS_CERT",
    "ROAMGATE_TLS_KEY",
    "ROAMGATE_DISABLE_UPDATE_CHECK",
    "HERDR_SSH_HOST",
    "HERDR_SESSION",
    "ROAMGATE_TEST_CLOCK",
    "ROAMGATE_TEST_CLOCK_EPOCH",
    "ROAMGATE_CONTRACT_RECORD",
    "HERDR_SOCKET_PATH",
    "HERDR_CLIENT_SOCKET_PATH",
    "ROAMGATE_PASSWORD",
    "ROAMGATE_HOST_SPAWN",
    "ROAMGATE_SSH_RUNTIME_DIR",
];

/// How long a server gets to listen (a niced Bun on a busy machine).
pub const START_TIMEOUT: Duration = Duration::from_secs(60);

#[derive(Debug, Clone)]
pub struct RunOptions {
    /// Variables for the server, over the run's own.
    pub env: BTreeMap<String, String>,
    /// The fake Herdr's session, or None for no Herdr at all.
    pub herdr: Option<HerdrSeed>,
    /// More fake Herdrs, by id: their sockets are `${HERDR_<id>_CONTROL}`
    /// and `${HERDR_<id>_CLIENT}` in seeded files and variables (for
    /// connection profiles).
    pub herdrs: BTreeMap<String, HerdrSeed>,
    pub epoch_ms: i64,
    /// Files to write before the start, by path relative to HOME.
    pub files: Vec<SeedFile>,
    /// Scripts of the command fakes, by program.
    pub fakes: BTreeMap<String, Value>,
    /// fake-openai's script.
    pub openai: Value,
    /// Files fake-models serves, by path under `/files/`.
    pub served: BTreeMap<String, Vec<u8>>,
    pub password: Option<String>,
    /// The server command and its working directory, instead of
    /// `server_command()` (a standalone binary, see build.rs).
    /// The working directory may name `${ROOT}` and `${HOME}`.
    pub command: Option<(Vec<String>, String)>,
    /// Whether the server runs on the test clock (a release build refuses
    /// it).
    pub clock: bool,
}

impl Default for RunOptions {
    fn default() -> Self {
        RunOptions {
            env: BTreeMap::new(),
            herdr: Some(HerdrSeed::default()),
            herdrs: BTreeMap::new(),
            epoch_ms: DEFAULT_EPOCH_MS,
            files: Vec::new(),
            fakes: BTreeMap::new(),
            openai: Value::Null,
            served: BTreeMap::new(),
            password: Some(PASSWORD.into()),
            command: None,
            clock: true,
        }
    }
}

#[derive(Debug, Clone)]
pub struct SeedFile {
    pub path: String,
    pub content: Vec<u8>,
    pub mode: Option<u32>,
}

struct Server {
    child: Child,
    port: u16,
}

pub struct Run {
    _dir: Option<tempfile::TempDir>,
    pub root: PathBuf,
    pub home: PathBuf,
    pub fakes_dir: PathBuf,
    pub bin: PathBuf,
    pub record_dir: PathBuf,
    pub clock_path: PathBuf,
    /// The server's whole environment.
    pub env: BTreeMap<String, String>,
    pub command: Vec<String>,
    pub cwd: PathBuf,
    pub herdr: Option<FakeHerdr>,
    pub herdrs: BTreeMap<String, FakeHerdr>,
    pub http: FakeHttp,
    /// Everything the server wrote on stdout and stderr, across restarts.
    pub log: Arc<Mutex<String>>,
    server: Option<Server>,
    /// Cookie jars by browser name (`main` unless a step says).
    pub cookies: BTreeMap<String, BTreeMap<String, String>>,
    pub password: Option<String>,
    /// The last exit code of a stopped server.
    pub last_exit: Option<i32>,
}

/// The server command: `ROAMGATE_SERVER_CMD`, or the Bun server.
pub fn server_command() -> (Vec<String>, PathBuf) {
    let repo = repo_root();
    match std::env::var("ROAMGATE_SERVER_CMD") {
        Ok(command) if !command.trim().is_empty() => (
            command.split_whitespace().map(str::to_owned).collect(),
            std::env::var_os("ROAMGATE_SERVER_CWD")
                .map(PathBuf::from)
                .unwrap_or_else(|| repo.clone()),
        ),
        _ => (
            vec![
                "bun".into(),
                repo.join("server/src/index.ts")
                    .to_string_lossy()
                    .into_owned(),
            ],
            repo,
        ),
    }
}

/// The data root under a HOME, as the server derives it.
pub fn data_root(home: &Path) -> PathBuf {
    if cfg!(windows) {
        home.join("AppData").join("Roaming").join("roamgate")
    } else {
        home.join(".config").join("roamgate")
    }
}

fn private_dir(path: &Path) -> Result<()> {
    std::fs::create_dir_all(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

fn write_seed(home: &Path, file: &SeedFile) -> Result<()> {
    let path = home.join(&file.path);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&path, &file.content).with_context(|| path.display().to_string())?;
    #[cfg(unix)]
    if let Some(mode) = file.mode {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(mode))?;
    }
    Ok(())
}

impl Run {
    /// Prepares a run (fakes up, files written); the server is not started.
    pub async fn new(fake_bin: &Path, options: RunOptions) -> Result<Run> {
        // Short paths: Unix socket paths are limited to about 100 bytes.
        let dir = tempfile::Builder::new().prefix("rgp-").tempdir()?;
        let root = dir.path().canonicalize()?;
        let keep = std::env::var_os("PARITY_KEEP").is_some();
        let home = root.join("home");
        let fakes_dir = root.join("fakes");
        let bin = root.join("bin");
        let record_dir = root.join("record");
        let clock_path = root.join("clock.sock");
        for path in [
            &home,
            &fakes_dir,
            &root.join("tmp"),
            &root.join("remote-home"),
        ] {
            std::fs::create_dir_all(path)?;
        }
        // The run is private, as a real data root's parents are.
        private_dir(&root)?;
        private_dir(&root.join("runtime"))?;
        fakes::install(fake_bin, &bin)?;
        for (program, script) in &options.fakes {
            std::fs::write(
                fakes_dir.join(format!("{program}.json")),
                serde_json::to_string_pretty(script)?,
            )?;
        }
        // git commits in fixtures and by the server need an identity.
        std::fs::write(
            home.join(".gitconfig"),
            "[user]\n\tname = Parity\n\temail = parity@example.invalid\n[init]\n\tdefaultBranch = main\n",
        )?;
        // Up first: seeded files may name its address (`${FAKE_HTTP}`).
        let served = root.join("served");
        let http = FakeHttp::start(served.clone(), options.openai.clone()).await?;
        let expand = |text: &str| {
            let mut text = text
                .replace("${ROOT}", &root.to_string_lossy())
                .replace("${HOME}", &home.to_string_lossy())
                .replace("${BIN}", &bin.to_string_lossy())
                .replace("${FAKE_HTTP}", &http.base);
            for id in options.herdrs.keys() {
                let dir = root.join(format!("herdr-{id}"));
                text = text
                    .replace(
                        &format!("${{HERDR_{id}_CONTROL}}"),
                        &dir.join("herdr.sock").to_string_lossy(),
                    )
                    .replace(
                        &format!("${{HERDR_{id}_CLIENT}}"),
                        &dir.join("client.sock").to_string_lossy(),
                    );
            }
            text
        };
        for file in &options.files {
            let mut file = file.clone();
            file.path = expand(&file.path);
            if let Ok(text) = std::str::from_utf8(&file.content) {
                file.content = expand(text).into_bytes();
            }
            write_seed(&home, &file)?;
        }
        // Seeds name the run's paths (${ROOT}, ${HOME}) too.
        let expand_seed = |seed: &HerdrSeed| -> Result<HerdrSeed> {
            Ok(serde_json::from_str(&expand(&serde_json::to_string(
                seed,
            )?))?)
        };
        let herdr = match &options.herdr {
            Some(seed) => Some(FakeHerdr::start(&root.join("herdr"), &expand_seed(seed)?).await?),
            None => None,
        };
        let mut herdrs = BTreeMap::new();
        for (id, seed) in &options.herdrs {
            herdrs.insert(
                id.clone(),
                FakeHerdr::start(&root.join(format!("herdr-{id}")), &expand_seed(seed)?).await?,
            );
        }
        for (path, bytes) in &options.served {
            let path = served.join(path);
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent)?;
            }
            std::fs::write(path, bytes)?;
        }

        let (command, cwd) = match &options.command {
            Some((command, cwd)) => (command.clone(), PathBuf::from(expand(cwd))),
            None => server_command(),
        };
        let path_var = std::env::var("PATH").unwrap_or_default();
        let separator = if cfg!(windows) { ";" } else { ":" };
        let text = |path: &Path| path.to_string_lossy().into_owned();
        let mut env = BTreeMap::new();
        let mut set = |key: &str, value: String| {
            env.insert(key.to_owned(), value);
        };
        set("PATH", format!("{}{separator}{path_var}", text(&bin)));
        set("HOME", text(&home));
        set("USERPROFILE", text(&home));
        set("APPDATA", text(&home.join("AppData").join("Roaming")));
        set("LOCALAPPDATA", text(&home.join("AppData").join("Local")));
        set("XDG_CONFIG_HOME", text(&home.join(".config")));
        set("XDG_DATA_HOME", text(&home.join(".local").join("share")));
        set("XDG_CACHE_HOME", text(&home.join(".cache")));
        set("XDG_STATE_HOME", text(&home.join(".local").join("state")));
        set("XDG_RUNTIME_DIR", text(&root.join("runtime")));
        set("TMPDIR", text(&root.join("tmp")));
        set("TZ", "UTC".into());
        set("LANG", "C.UTF-8".into());
        set("NODE_ENV", "production".into());
        set("HOST", "127.0.0.1".into());
        set("PORT", "0".into());
        set("OPEN_BROWSER", "0".into());
        set("ROAMGATE_PIN", String::new());
        set("ROAMGATE_TLS_CERT", String::new());
        set("ROAMGATE_TLS_KEY", String::new());
        set("ROAMGATE_DISABLE_UPDATE_CHECK", "1".into());
        set("HERDR_SSH_HOST", String::new());
        set("HERDR_SESSION", String::new());
        set("GIT_CONFIG_NOSYSTEM", "1".into());
        if options.clock {
            set("ROAMGATE_TEST_CLOCK", text(&clock_path));
            set("ROAMGATE_TEST_CLOCK_EPOCH", options.epoch_ms.to_string());
        }
        set("ROAMGATE_CONTRACT_RECORD", text(&record_dir));
        set(script::FAKES_DIR_ENV, text(&fakes_dir));
        set("PARITY_REMOTE_HOME", text(&root.join("remote-home")));
        // Never the real host's host-spawn (GameMode), never /tmp for SSH
        // runtimes (another server's masters).
        set(
            "ROAMGATE_HOST_SPAWN",
            text(&bin.join(fakes::exe("host-spawn"))),
        );
        private_dir(&root.join("ssh"))?;
        set("ROAMGATE_SSH_RUNTIME_DIR", text(&root.join("ssh")));
        set("PARITY_FAKE_HTTP", http.base.clone());
        // Without a Herdr of the run's own: the server's default (under the
        // run's HOME), or the connection profiles a scenario seeds.
        if let Some(herdr) = &herdr {
            set("HERDR_SOCKET_PATH", text(&herdr.control));
            set("HERDR_CLIENT_SOCKET_PATH", text(&herdr.client));
        }
        if let Some(password) = &options.password {
            set("ROAMGATE_PASSWORD", password.clone());
        }
        for (key, value) in &options.env {
            // `{{unset}}`: a variable the run would set, left out (a
            // legacy name read alone).
            if value == "{{unset}}" {
                env.remove(key);
                continue;
            }
            env.insert(
                key.clone(),
                expand(value).replace("${FAKE_HTTP}", &http.base),
            );
        }
        let _ = keep;
        // What runs in the fake Herdr's terminal panes (the pane holder)
        // gets the server's environment, on the real clock.
        let mut pane_env = env.clone();
        pane_env.remove("ROAMGATE_TEST_CLOCK");
        pane_env.remove("ROAMGATE_TEST_CLOCK_EPOCH");
        for fake in herdr.iter().chain(herdrs.values()) {
            let mut env = pane_env.clone();
            env.insert("HERDR_SOCKET_PATH".into(), text(&fake.control));
            fake.attach_shell(crate::fakes::herdr_panes::Shell {
                env,
                bin: bin.clone(),
                dir: fake
                    .control
                    .parent()
                    .map(Path::to_path_buf)
                    .unwrap_or_else(|| root.clone()),
            });
        }
        Ok(Run {
            _dir: if keep {
                let _ = dir.keep();
                None
            } else {
                Some(dir)
            },
            root,
            home,
            fakes_dir,
            bin,
            record_dir,
            clock_path,
            env,
            command,
            cwd,
            herdr,
            herdrs,
            http,
            log: Arc::new(Mutex::new(String::new())),
            server: None,
            cookies: BTreeMap::new(),
            password: options.password.clone(),
            last_exit: None,
        })
    }

    pub fn data_root(&self) -> PathBuf {
        data_root(&self.home)
    }

    /// `$ROOT`, `$HOME`, `$DATA` for the normalizers and interpolation.
    pub fn paths(&self) -> RunPaths {
        let mut by_name = BTreeMap::new();
        by_name.insert("root".into(), self.root.to_string_lossy().into_owned());
        by_name.insert("home".into(), self.home.to_string_lossy().into_owned());
        RunPaths { by_name }
    }

    /// Starts the server and waits until it listens.
    pub async fn start(&mut self) -> Result<()> {
        if self.server.is_some() {
            bail!("the server is already running");
        }
        let (program, args) = self.command.split_first().context("empty server command")?;
        let mut child = Command::new(program)
            .args(args)
            .env_clear()
            .envs(&self.env)
            .current_dir(&self.cwd)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .with_context(|| format!("start {}", self.command.join(" ")))?;
        let (ready, listening) = oneshot::channel::<u16>();
        let pattern = Regex::new(r"bridge listening url=https?://[^\s:]+:(\d+)").expect("regex");
        let stdout = child.stdout.take().context("stdout")?;
        let stderr = child.stderr.take().context("stderr")?;
        let log = self.log.clone();
        tokio::spawn(async move {
            let mut ready = Some(ready);
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if let Some(port) = pattern
                    .captures(&line)
                    .and_then(|found| found[1].parse().ok())
                    && let Some(ready) = ready.take()
                {
                    let _ = ready.send(port);
                }
                let mut log = log.lock().expect("log");
                log.push_str(&line);
                log.push('\n');
            }
        });
        let log = self.log.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let mut log = log.lock().expect("log");
                log.push_str("[stderr] ");
                log.push_str(&line);
                log.push('\n');
            }
        });
        let port = tokio::select! {
            port = listening => port.map_err(|_| anyhow!("the server ended before listening")),
            status = child.wait() => Err(anyhow!("the server exited before listening: {status:?}")),
            () = tokio::time::sleep(START_TIMEOUT) => Err(anyhow!("the server did not listen within {START_TIMEOUT:?}")),
        };
        let port =
            port.map_err(|error| anyhow!("{error}\n--- server output ---\n{}", self.log_text()))?;
        self.server = Some(Server { child, port });
        Ok(())
    }

    /// Stops the server (SIGTERM, then SIGKILL after 15 s); gives its exit
    /// code.
    pub async fn stop(&mut self) -> Result<Option<i32>> {
        self.stop_with("TERM").await
    }

    /// Stops the server with a signal (`TERM`, `INT`, `KILL`), then
    /// SIGKILL after 15 s; gives its exit code (128 + the signal when a
    /// signal ended it).
    pub async fn stop_with(&mut self, signal: &str) -> Result<Option<i32>> {
        let Some(mut server) = self.server.take() else {
            return Ok(None);
        };
        #[cfg(unix)]
        if let Some(pid) = server.child.id() {
            let _ = std::process::Command::new("kill")
                .args([format!("-{signal}"), pid.to_string()])
                .status();
        }
        #[cfg(not(unix))]
        let _ = signal;
        let status = match tokio::time::timeout(Duration::from_secs(15), server.child.wait()).await
        {
            Ok(status) => status?,
            Err(_) => {
                server.child.kill().await?;
                server.child.wait().await?
            }
        };
        let code = status.code().or_else(|| {
            #[cfg(unix)]
            {
                use std::os::unix::process::ExitStatusExt;
                status.signal().map(|signal| 128 + signal)
            }
            #[cfg(not(unix))]
            {
                None
            }
        });
        self.last_exit = code;
        Ok(code)
    }

    /// The default fake Herdr, or the one of that id.
    pub fn fake_herdr(&self, id: Option<&str>) -> Result<&FakeHerdr> {
        match id {
            None | Some("default") => self.herdr.as_ref().context("no fake Herdr in this run"),
            Some(id) => self
                .herdrs
                .get(id)
                .with_context(|| format!("no fake Herdr {id}")),
        }
    }

    pub fn running(&self) -> bool {
        self.server.is_some()
    }

    pub fn port(&self) -> Result<u16> {
        self.server
            .as_ref()
            .map(|server| server.port)
            .ok_or_else(|| anyhow!("the server is not running"))
    }

    pub fn base(&self) -> Result<String> {
        Ok(format!("http://127.0.0.1:{}", self.port()?))
    }

    pub fn address(&self) -> Result<String> {
        Ok(format!("127.0.0.1:{}", self.port()?))
    }

    pub fn clock(&self) -> Clock {
        Clock::new(&self.clock_path)
    }

    pub fn log_text(&self) -> String {
        self.log.lock().expect("log").clone()
    }

    pub fn cookie_header(&self, jar: &str) -> Option<String> {
        let cookies = self
            .cookies
            .get(jar)
            .filter(|cookies| !cookies.is_empty())?;
        Some(
            cookies
                .iter()
                .map(|(name, value)| format!("{name}={value}"))
                .collect::<Vec<_>>()
                .join("; "),
        )
    }

    pub fn fake_calls(&self) -> Vec<script::Call> {
        script::read_calls(&self.fakes_dir)
    }
}

impl Drop for Run {
    fn drop(&mut self) {
        if let Some(server) = self.server.as_mut() {
            let _ = server.child.start_kill();
        }
    }
}
