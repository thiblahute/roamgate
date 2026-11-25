//! A sandbox for running a packaged roamgate as a user would, shared by the
//! update proof and the smoke test: its own HOME (and the XDG and Windows
//! profile directories under it), TMPDIR, no service and no user bus, the
//! commands run with only that environment, optionally through a prefix (a
//! container); plain HTTP over loopback to the server it starts.

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Output, Stdio};
use std::time::{Duration, Instant};

use anyhow::{Context, Result, bail, ensure};

/// The variables of the runner's environment a Windows process needs to
/// start at all (Winsock reads `SystemRoot`).
#[cfg(windows)]
const WINDOWS_KEPT: &[&str] = &[
    "SystemRoot",
    "SystemDrive",
    "windir",
    "ComSpec",
    "PATHEXT",
    "NUMBER_OF_PROCESSORS",
    "PROCESSOR_ARCHITECTURE",
];

pub struct Sandbox {
    pub root: PathBuf,
    pub home: PathBuf,
    pub env: Vec<(String, String)>,
    pub prefix: Vec<String>,
}

impl Sandbox {
    /// A sandbox under `root` (created), with `extra` variables.
    pub fn new(root: &Path, prefix: Vec<String>, extra: &[(&str, String)]) -> Result<Self> {
        let home = root.join("home");
        let tmp = root.join("tmp");
        for dir in [&home, &tmp] {
            std::fs::create_dir_all(dir)?;
        }
        let path = if prefix.is_empty() {
            std::env::var("PATH").unwrap_or_default()
        } else {
            "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin".to_owned()
        };
        let dir = |sub: &str| home.join(sub).to_string_lossy().into_owned();
        let tmp_text = tmp.to_string_lossy().into_owned();
        let mut env: Vec<(String, String)> = vec![
            ("HOME".into(), home.to_string_lossy().into_owned()),
            ("PATH".into(), path),
            ("LANG".into(), "C.UTF-8".into()),
            ("TMPDIR".into(), tmp_text.clone()),
            ("XDG_CONFIG_HOME".into(), dir(".config")),
            ("XDG_DATA_HOME".into(), dir(".local/share")),
            ("XDG_CACHE_HOME".into(), dir(".cache")),
            ("XDG_STATE_HOME".into(), dir(".local/state")),
            // No host-spawn from a toolbox: the sandbox never reaches the host.
            ("ROAMGATE_HOST_SPAWN".into(), String::new()),
        ];
        if cfg!(windows) && prefix.is_empty() {
            env.extend([
                ("USERPROFILE".into(), home.to_string_lossy().into_owned()),
                ("APPDATA".into(), dir("AppData/Roaming")),
                ("LOCALAPPDATA".into(), dir("AppData/Local")),
                ("TEMP".into(), tmp_text.clone()),
                ("TMP".into(), tmp_text),
            ]);
        }
        env.extend(extra.iter().map(|(k, v)| ((*k).to_owned(), v.clone())));
        Ok(Self {
            root: root.to_path_buf(),
            home,
            env,
            prefix,
        })
    }

    pub fn command(&self, program: &Path, args: &[&str]) -> Command {
        self.command_with(&[], program, args)
    }

    /// [`Sandbox::command`] with `extra` variables over the sandbox's.
    pub fn command_with(&self, extra: &[(&str, &str)], program: &Path, args: &[&str]) -> Command {
        let pairs = self
            .env
            .iter()
            .map(|(k, v)| (k.as_str(), v.as_str()))
            .chain(extra.iter().copied());
        let mut command = match self.prefix.split_first() {
            // The prefix's own environment is not the sandbox's: `env -i`
            // inside it.
            Some((first, rest)) => {
                let mut command = Command::new(first);
                command.args(rest).arg("env").arg("-i");
                for (key, value) in pairs {
                    command.arg(format!("{key}={value}"));
                }
                command.arg(program);
                command
            }
            None => {
                let mut command = Command::new(program);
                command.env_clear();
                #[cfg(windows)]
                for key in WINDOWS_KEPT {
                    if let Some(value) = std::env::var_os(key) {
                        command.env(key, value);
                    }
                }
                command.envs(pairs);
                command
            }
        };
        command.args(args).current_dir(&self.home);
        command
    }

    pub fn run(&self, program: &Path, args: &[&str]) -> Result<Output> {
        let output = self
            .command(program, args)
            .stdin(Stdio::null())
            .output()
            .with_context(|| format!("running {} {args:?}", program.display()))?;
        eprintln!(
            "xtask: $ {} {}\n{}{}",
            program
                .strip_prefix(&self.root)
                .unwrap_or(program)
                .display(),
            args.join(" "),
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        Ok(output)
    }

    /// `program --version`'s version.
    pub fn version(&self, program: &Path) -> Result<String> {
        let output = self.run(program, &["--version"])?;
        ensure!(
            output.status.success(),
            "{} --version failed ({})",
            program.display(),
            output.status
        );
        let line = String::from_utf8_lossy(&output.stdout).trim().to_owned();
        line.strip_prefix("roamgate ")
            .map(str::to_owned)
            .with_context(|| format!("{} --version printed {line:?}", program.display()))
    }

    /// Starts `bin` serving on 127.0.0.1:`port` with `extra` variables;
    /// stopped when dropped.
    pub fn serve(&self, bin: &Path, port: u16, extra: &[(&str, &str)]) -> Result<Server> {
        let port_text = port.to_string();
        let serve = ["--host", "127.0.0.1", "--port", &port_text];
        // A prefix may not pass signals on (a container started through a
        // toolbox's host-spawn, `docker exec`): there the server ends itself.
        let mut command = if self.prefix.is_empty() {
            self.command_with(extra, bin, &serve)
        } else {
            let bin_text = bin.to_string_lossy();
            let mut args = vec!["-s", "TERM", "120", &bin_text];
            args.extend(serve);
            self.command_with(extra, Path::new("timeout"), &args)
        };
        let child = command
            .stdin(Stdio::null())
            .spawn()
            .context("starting the server")?;
        Ok(Server(child))
    }
}

pub struct Server(pub Child);

impl Server {
    /// Whether the server is still running.
    pub fn running(&mut self) -> bool {
        matches!(self.0.try_wait(), Ok(None))
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        // SIGTERM, which a container prefix passes on; then make sure.
        #[cfg(unix)]
        {
            let _ = Command::new("kill").arg(self.0.id().to_string()).status();
            let deadline = Instant::now() + Duration::from_secs(20);
            while Instant::now() < deadline {
                if let Ok(Some(_)) = self.0.try_wait() {
                    return;
                }
                std::thread::sleep(Duration::from_millis(100));
            }
        }
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

pub fn free_port() -> Result<u16> {
    Ok(TcpListener::bind("127.0.0.1:0")?.local_addr()?.port())
}

pub struct Response {
    pub status: u16,
    /// The status line and headers.
    pub head: String,
    pub body: Vec<u8>,
}

impl Response {
    /// A header's value (the first one).
    pub fn header(&self, name: &str) -> Option<&str> {
        self.head.lines().skip(1).find_map(|line| {
            let (key, value) = line.split_once(':')?;
            key.trim().eq_ignore_ascii_case(name).then(|| value.trim())
        })
    }

    pub fn text(&self) -> String {
        String::from_utf8_lossy(&self.body).into_owned()
    }
}

/// One HTTP/1.1 request over loopback (`Connection: close`).
pub fn request(
    address: SocketAddr,
    method: &str,
    path: &str,
    headers: &[(&str, &str)],
    body: &[u8],
) -> Result<Response> {
    let mut stream = TcpStream::connect_timeout(&address, Duration::from_secs(2))?;
    stream.set_read_timeout(Some(Duration::from_secs(30)))?;
    let mut text = format!("{method} {path} HTTP/1.1\r\nHost: {address}\r\nConnection: close\r\n");
    for (name, value) in headers {
        text.push_str(&format!("{name}: {value}\r\n"));
    }
    if !body.is_empty() || method == "POST" {
        text.push_str(&format!("Content-Length: {}\r\n", body.len()));
    }
    text.push_str("\r\n");
    stream.write_all(text.as_bytes())?;
    stream.write_all(body)?;
    let mut response = Vec::new();
    stream.read_to_end(&mut response)?;
    parse_response(&response)
}

pub fn parse_response(response: &[u8]) -> Result<Response> {
    let split = response
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .context("no end of headers")?;
    let head = String::from_utf8_lossy(&response[..split]).into_owned();
    let status = head
        .split_whitespace()
        .nth(1)
        .and_then(|code| code.parse().ok())
        .context("no status")?;
    ensure!(
        !head
            .to_ascii_lowercase()
            .contains("transfer-encoding: chunked"),
        "chunked response"
    );
    Ok(Response {
        status,
        head,
        body: response[split + 4..].to_vec(),
    })
}

/// GET over loopback, accepting HTML as a browser's navigation does (an app
/// route is the web app only then): status and body.
pub fn get(address: SocketAddr, path: &str) -> Result<(u16, Vec<u8>)> {
    let response = request(address, "GET", path, &[("Accept", "text/html")], &[])?;
    Ok((response.status, response.body))
}

/// Waits for `/healthz` to answer `Ok`; fails early when the server exits.
pub fn wait_healthy(server: &mut Server, address: SocketAddr) -> Result<()> {
    let deadline = Instant::now() + Duration::from_secs(60);
    let health = loop {
        match get(address, "/healthz") {
            Ok(answer) => break answer,
            Err(error) if Instant::now() > deadline => bail!("the server never answered: {error}"),
            Err(error) if !server.running() => bail!("the server exited: {error}"),
            Err(_) => std::thread::sleep(Duration::from_millis(250)),
        }
    };
    ensure!(
        health == (200, b"Ok".to_vec()),
        "/healthz answered {health:?}"
    );
    Ok(())
}

/// The packages a container image needs for the Pi sidecar: Bun's musl
/// build links libstdc++ and libgcc dynamically.
const ALPINE_PACKAGES: &[&str] = &["libstdc++", "libgcc"];

/// A container of an image (docker, or podman), sharing the network and a
/// directory at the same path: a sandbox under [`Container::shared`] runs
/// its commands through [`Container::prefix`]. Removed when dropped.
pub struct Container {
    engine: &'static str,
    name: String,
    pub shared: PathBuf,
    _base: TempDir,
}

impl Container {
    pub fn start(image: &str) -> Result<Self> {
        let engine = ["docker", "podman"]
            .into_iter()
            .find(|engine| {
                Command::new(engine)
                    .arg("--version")
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .status()
                    .is_ok_and(|status| status.success())
            })
            .context("no docker or podman to run a container")?;
        let base = TempDir::new("container")?;
        let shared = dunce(base.0.clone());
        let name = format!("roamgate-xtask-{}", std::process::id());
        let volume = format!("{0}:{0}", shared.display());
        let status = Command::new(engine)
            .args(["run", "-d", "--rm", "--name", &name, "--network", "host"])
            .args(["-v", &volume, image, "sleep", "3600"])
            .status()
            .with_context(|| format!("running {engine}"))?;
        ensure!(status.success(), "starting a {image} container failed");
        let container = Self {
            engine,
            name,
            shared,
            _base: base,
        };
        if image.starts_with("alpine") {
            let status = Command::new(engine)
                .args(["exec", &container.name, "apk", "add", "--no-cache"])
                .args(ALPINE_PACKAGES)
                .status()?;
            ensure!(status.success(), "apk add {ALPINE_PACKAGES:?} failed");
        }
        eprintln!("xtask: in a {image} container ({engine})");
        Ok(container)
    }

    /// The prefix running a command in the container, its stdin open, as
    /// this user: what it writes in the shared directory (the server's
    /// private 0700 directories) stays readable from here.
    pub fn prefix(&self) -> Vec<String> {
        let mut prefix = vec![self.engine.to_owned(), "exec".into(), "-i".into()];
        if let Some(user) = host_user() {
            prefix.extend(["-u".into(), user]);
        }
        prefix.push(self.name.clone());
        prefix
    }
}

/// `uid:gid` of this process, on Unix.
fn host_user() -> Option<String> {
    if !cfg!(unix) {
        return None;
    }
    let id = |flag: &str| {
        Command::new("id")
            .arg(flag)
            .output()
            .ok()
            .filter(|output| output.status.success())
            .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_owned())
    };
    Some(format!("{}:{}", id("-u")?, id("-g")?))
}

impl Drop for Container {
    fn drop(&mut self) {
        let _ = Command::new(self.engine)
            .args(["rm", "-f", &self.name])
            .stdout(Stdio::null())
            .status();
    }
}

/// A directory removed when dropped.
pub struct TempDir(pub PathBuf);

impl TempDir {
    pub fn new(name: &str) -> Result<Self> {
        // macOS' temporary directory is deep (/var/folders/...): a HOME under
        // it puts the server's sockets past the 104 bytes of a socket path,
        // which no user's HOME does. /tmp is short there.
        let base = if cfg!(target_os = "macos") {
            PathBuf::from("/tmp")
        } else {
            std::env::temp_dir()
        };
        for attempt in 0..100u32 {
            let path = base.join(format!("roamgate-{name}-{}-{attempt}", std::process::id()));
            if std::fs::create_dir(&path).is_ok() {
                return Ok(Self(path.canonicalize()?));
            }
        }
        bail!("no temporary directory in {}", base.display())
    }

    /// `keep` (emptied) when given, else a new temporary directory.
    pub fn or_keep(name: &str, keep: Option<&Path>) -> Result<(Option<Self>, PathBuf)> {
        match keep {
            Some(dir) => {
                if dir.exists() {
                    std::fs::remove_dir_all(dir)?;
                }
                std::fs::create_dir_all(dir)?;
                Ok((None, dunce(dir.canonicalize()?)))
            }
            None => {
                let temp = Self::new(name)?;
                let path = dunce(temp.0.clone());
                Ok((Some(temp), path))
            }
        }
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// A canonical path without Windows' `\\?\` prefix, which tar.exe, sockets
/// and the server's own path handling do not all take.
pub fn dunce(path: PathBuf) -> PathBuf {
    let text = path.to_string_lossy();
    match text.strip_prefix(r"\\?\") {
        Some(rest) if !rest.starts_with("UNC\\") => PathBuf::from(rest),
        _ => path,
    }
}
