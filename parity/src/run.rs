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
    /// What `cli` steps run: `ROAMGATE_CLI_CMD`, else the server command
    /// (a Rust front's CLI is still the Bun one, contract/wire/core-channel.md).
    pub cli_command: Vec<String>,
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
    /// With a core, told when the last start's core connected.
    core_connected: Option<oneshot::Receiver<()>>,
    /// Each start waits for the core to connect (a scenario of a family
    /// PARITY_RUST_OWNERS gives to Rust).
    pub wait_for_core: bool,
}

/// The variable naming the Rust core a Bun server runs beside it.
pub const CORE_BIN_ENV: &str = "ROAMGATE_CORE_BIN";

/// The families every server of a hybrid run gives to Rust
/// (`PARITY_RUST_OWNERS`, comma separated families of
/// contract/owners/families.json): written as the run's
/// `<data>/runtime/owners.json` unless a scenario seeds its own. Empty
/// without a core.
pub fn rust_owners() -> Vec<String> {
    if hybrid_core().is_none() {
        return Vec::new();
    }
    std::env::var("PARITY_RUST_OWNERS")
        .unwrap_or_default()
        .split(',')
        .map(str::trim)
        .filter(|family| !family.is_empty())
        .map(str::to_owned)
        .collect()
}

/// Families that flip only behind the Rust front (contract/wire/
/// core-channel.md: the voice family, whose socket the Bun front keeps):
/// a hybrid run on the Bun front that gives one to Rust skips its
/// scenarios, as if they named `fronts: [rust]`.
pub const RUST_FRONT_ONLY: &[&str] = &["voice"];

/// Whether this run skips a scenario of `family` (its owners table's
/// family): Rust's on the Bun front, and flipping only behind the Rust
/// front.
pub fn rust_owned_off_its_front(family: &str, front: &str) -> bool {
    front == "bun"
        && RUST_FRONT_ONLY.contains(&family)
        && rust_owners().iter().any(|name| name == family)
}

/// The variable naming the file a debug core appends what it served to
/// (`<family> <method or path or cli command>` per line).
pub const CORE_SERVED_LOG_ENV: &str = "ROAMGATE_CORE_SERVED_LOG";

/// How long a hybrid server's core gets to connect after the server
/// listens (a niced first start of a debug build).
pub const CORE_CONNECT_TIMEOUT: Duration = Duration::from_secs(60);

/// The Rust core every server of the suite runs with: `ROAMGATE_CORE_BIN`
/// of the suite's own environment, or None for the server alone. With
/// one, each start also waits for the core to connect, so a whole suite
/// run proves the hybrid build serves every case with the core up.
pub fn hybrid_core() -> Option<String> {
    std::env::var(CORE_BIN_ENV)
        .ok()
        .filter(|path| !path.trim().is_empty())
}

/// Whether the suite's server runs no Bun at all: `ROAMGATE_SERVER_CMD` is
/// a Rust `roamgate front` and `ROAMGATE_SIDECAR_BIN` is unset, so the
/// front runs its own executable as the standalone core
/// (contract/wire/core-channel.md, The standalone core).
pub fn rust_only() -> bool {
    let sidecar = std::env::var("ROAMGATE_SIDECAR_BIN").unwrap_or_default();
    if !sidecar.trim().is_empty() {
        return false;
    }
    let (command, _) = server_command();
    let mut words = command.iter();
    let program = words.next().map(|program| {
        Path::new(program)
            .file_stem()
            .map(|stem| stem.to_string_lossy().into_owned())
            .unwrap_or_default()
    });
    program.is_some_and(|program| program.starts_with("roamgate"))
        && words.next().is_some_and(|word| word == "front")
}

/// The variable naming the Pi sidecar a server runs Pi in.
pub const PI_SIDECAR_ENV: &str = "ROAMGATE_PI_SIDECAR";

/// The Pi sidecar `roamgate-pi` compiled from this checkout
/// (server/package.json's `compile:pi`, unminified), built once per
/// process into `<target>/parity-pi/`: what `cargo xtask package` ships
/// beside `roamgate`. None, said once on stderr, when Bun cannot build it.
pub fn pi_sidecar() -> Option<PathBuf> {
    static BUILT: std::sync::OnceLock<Option<PathBuf>> = std::sync::OnceLock::new();
    BUILT
        .get_or_init(|| match build_pi_sidecar() {
            Ok(path) => Some(path),
            Err(error) => {
                eprintln!("parity: no Pi sidecar: {error:#}");
                None
            }
        })
        .clone()
}

fn build_pi_sidecar() -> Result<PathBuf> {
    let repo = repo_root();
    let target = std::env::var_os("CARGO_TARGET_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| repo.join("target"));
    let dir = target.join("parity-pi");
    std::fs::create_dir_all(&dir)?;
    let name = if cfg!(windows) {
        "roamgate-pi.exe"
    } else {
        "roamgate-pi"
    };
    let path = dir.join(name);
    // Built aside and renamed: another suite's servers may run the last one.
    let building = dir.join(format!("{name}.{}.tmp", std::process::id()));
    let output = std::process::Command::new("bun")
        .args([
            "build",
            "--compile",
            "--no-compile-autoload-dotenv",
            "--no-compile-autoload-bunfig",
            "src/assistant/pi-sidecar-main.ts",
            "--outfile",
        ])
        .arg(&building)
        .current_dir(repo.join("server"))
        .stdin(Stdio::null())
        .output()
        .context("run bun build")?;
    if !output.status.success() {
        let _ = std::fs::remove_file(&building);
        bail!(
            "bun build --compile failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }
    std::fs::rename(&building, &path)?;
    Ok(path)
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
        // The Rust core, built only for a run that names it.
        let core = if serde_json::to_string(&options.env)?.contains("${CORE}") {
            crate::build::core()?.to_string_lossy().into_owned()
        } else {
            String::new()
        };
        let expand = |text: &str| {
            let mut text = text
                .replace("${CORE}", &core)
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
        // The families a hybrid run gives to Rust, unless the scenario
        // seeds its own table.
        let owners_path = data_root(&home).join("runtime").join("owners.json");
        let rust = rust_owners();
        if !rust.is_empty() && !owners_path.exists() {
            std::fs::create_dir_all(owners_path.parent().unwrap())?;
            let owners: serde_json::Map<String, Value> = rust
                .iter()
                .map(|family| (family.clone(), Value::String("rust".into())))
                .collect();
            std::fs::write(
                &owners_path,
                serde_json::to_string_pretty(&serde_json::json!({
                    "version": 1,
                    "owners": owners,
                    "shadow": {"enabled": false, "rate": 0},
                }))?,
            )?;
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
        let cli_command = match (&options.command, std::env::var("ROAMGATE_CLI_CMD")) {
            (None, Ok(cli)) if !cli.trim().is_empty() => {
                cli.split_whitespace().map(str::to_owned).collect()
            }
            _ => command.clone(),
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
        // The hybrid build (contract/wire/core-channel.md): the server with
        // its Rust core, when the suite is told where the core is.
        if let Some(core) = hybrid_core() {
            set(CORE_BIN_ENV, core);
            set(CORE_SERVED_LOG_ENV, text(&root.join("core-served.log")));
        }
        // Rust only: what the standalone core served, did not serve
        // (`unported`) and the reverse targets it lacked, for the report.
        if options.command.is_none() && rust_only() {
            set(CORE_SERVED_LOG_ENV, text(&root.join("core-served.log")));
        }
        // Rust only: Ranger's providers but Claude Code run Pi in the
        // `roamgate-pi` sidecar (contract/wire/pi-sidecar.md), which a
        // release ships beside `roamgate`; here the one this checkout
        // builds, unless the scenario names its own.
        if options.command.is_none()
            && rust_only()
            && let Some(sidecar) = pi_sidecar()
        {
            set(PI_SIDECAR_ENV, text(&sidecar));
        }
        // Stage 2 (contract/wire/core-channel.md): the Rust front runs
        // the Bun server the suite names as its core.
        if let Ok(sidecar) = std::env::var("ROAMGATE_SIDECAR_BIN")
            && !sidecar.trim().is_empty()
        {
            set("ROAMGATE_SIDECAR_BIN", sidecar);
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
            cli_command,
            cwd,
            herdr,
            herdrs,
            http,
            log: Arc::new(Mutex::new(String::new())),
            server: None,
            cookies: BTreeMap::new(),
            password: options.password.clone(),
            last_exit: None,
            core_connected: None,
            wait_for_core: false,
        })
    }

    pub fn data_root(&self) -> PathBuf {
        data_root(&self.home)
    }

    /// What the core served in this run (`<family> <what>` lines).
    pub fn core_served(&self) -> String {
        std::fs::read_to_string(self.root.join("core-served.log")).unwrap_or_default()
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
        // The front's line once the core said hello (core-channel/supervisor.ts).
        let (core_ready, core_connected) = oneshot::channel::<()>();
        let core_ready = Arc::new(Mutex::new(Some(core_ready)));
        let core_pattern = Regex::new(r"\bcore \S+ connected \(pid").expect("regex");
        let core_seen = {
            let core_ready = core_ready.clone();
            move |line: &str| {
                if core_pattern.is_match(line)
                    && let Some(ready) = core_ready.lock().expect("core ready").take()
                {
                    let _ = ready.send(());
                }
            }
        };
        let stdout = child.stdout.take().context("stdout")?;
        let stderr = child.stderr.take().context("stderr")?;
        let log = self.log.clone();
        let seen = core_seen.clone();
        tokio::spawn(async move {
            let mut ready = Some(ready);
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                // In the log before the run is told: a step after the start
                // finds the line it waited for.
                {
                    let mut log = log.lock().expect("log");
                    log.push_str(&line);
                    log.push('\n');
                }
                if let Some(port) = pattern
                    .captures(&line)
                    .and_then(|found| found[1].parse().ok())
                    && let Some(ready) = ready.take()
                {
                    let _ = ready.send(port);
                }
                seen(&line);
            }
        });
        let log = self.log.clone();
        let seen = core_seen;
        tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                {
                    let mut log = log.lock().expect("log");
                    log.push_str("[stderr] ");
                    log.push_str(&line);
                    log.push('\n');
                }
                seen(&line);
            }
        });
        let port = tokio::select! {
            port = listening => port.map_err(|_| anyhow!("the server ended before listening")),
            status = child.wait() => Err(anyhow!("the server exited before listening: {status:?}")),
            () = tokio::time::sleep(START_TIMEOUT) => Err(anyhow!("the server did not listen within {START_TIMEOUT:?}")),
        };
        let port =
            port.map_err(|error| anyhow!("{error}\n--- server output ---\n{}", self.log_text()))?;
        // Not waited for here: the server serves without its core, and a
        // scenario connects as soon as the port opens (pushes sent at
        // startup go to the browsers already there). `check_core` waits.
        // Rust only: the front's own core, welcomed before it listens;
        // a scenario's ROAMGATE_CORE_BIN is no Bun's to run.
        self.core_connected =
            (self.env.contains_key(CORE_BIN_ENV) && !rust_only()).then_some(core_connected);
        self.server = Some(Server { child, port });
        // A scenario of a family the run gives to Rust starts its steps once
        // the core is connected: until then Bun serves them, and the
        // family's background work would start at another time.
        if self.wait_for_core {
            self.check_core().await?;
        }
        Ok(())
    }

    /// With a core (`ROAMGATE_CORE_BIN`), whether the last start's core
    /// connected, waiting for it at most CORE_CONNECT_TIMEOUT: a scenario
    /// of the hybrid build fails when its server ran without the core.
    pub async fn check_core(&mut self) -> Result<()> {
        let Some(connected) = self.core_connected.take() else {
            return Ok(());
        };
        let connected = tokio::select! {
            connected = connected => connected.map_err(|_| anyhow!("the server ended before its core connected")),
            () = tokio::time::sleep(CORE_CONNECT_TIMEOUT) => Err(anyhow!("the core did not connect within {CORE_CONNECT_TIMEOUT:?}")),
        };
        connected.map_err(|error| {
            anyhow!(
                "hybrid: {error}\n--- server output ---\n{}",
                self.log_text()
            )
        })
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

impl Run {
    /// The processes under the server whose name says Bun (`bun`, or a
    /// compiled Bun build `roamgate.bun`); Linux only, empty elsewhere.
    pub fn bun_descendants(&self) -> Vec<String> {
        let Some(root) = self.server.as_ref().and_then(|server| server.child.id()) else {
            return Vec::new();
        };
        descendants_named_bun(root)
    }

    /// The served log's lines about what the standalone core lacked:
    /// `reverse-missing <target>` and `unported <method or route>`, with
    /// their counts.
    pub fn standalone_gaps(&self) -> BTreeMap<String, u64> {
        let mut gaps = BTreeMap::new();
        for line in self.core_served().lines() {
            if line.starts_with("reverse-missing ") || line.starts_with("unported ") {
                *gaps.entry(line.to_owned()).or_insert(0) += 1;
            }
        }
        gaps
    }
}

#[cfg(target_os = "linux")]
fn descendants_named_bun(root: u32) -> Vec<String> {
    let mut parents: Vec<(u32, u32, String)> = Vec::new();
    for entry in std::fs::read_dir("/proc").into_iter().flatten().flatten() {
        let Ok(pid) = entry.file_name().to_string_lossy().parse::<u32>() else {
            continue;
        };
        let Ok(stat) = std::fs::read_to_string(entry.path().join("stat")) else {
            continue;
        };
        // `pid (comm) state ppid ...`: comm may hold spaces and parens.
        let (Some(open), Some(close)) = (stat.find('('), stat.rfind(')')) else {
            continue;
        };
        let comm = stat[open + 1..close].to_owned();
        let ppid = stat[close + 1..]
            .split_whitespace()
            .nth(1)
            .and_then(|field| field.parse().ok())
            .unwrap_or(0);
        parents.push((pid, ppid, comm));
    }
    let mut found = Vec::new();
    let mut frontier = vec![root];
    while let Some(parent) = frontier.pop() {
        for (pid, ppid, comm) in &parents {
            if *ppid == parent {
                frontier.push(*pid);
                if comm == "bun" || comm.starts_with("roamgate.bun") {
                    found.push(format!("{pid} {comm}"));
                }
            }
        }
    }
    found
}

#[cfg(not(target_os = "linux"))]
fn descendants_named_bun(_root: u32) -> Vec<String> {
    Vec::new()
}

impl Drop for Run {
    fn drop(&mut self) {
        if let Some(server) = self.server.as_mut() {
            let _ = server.child.start_kill();
        }
        // A kept run keeps what its server wrote too.
        if self._dir.is_none() {
            let _ = std::fs::write(self.root.join("server.log"), self.log_text());
        }
    }
}
