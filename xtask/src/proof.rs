//! The update proof: a Bun-built roamgate, installed in a sandbox (its own
//! HOME, XDG directories and TMPDIR, no service, no user bus), updates itself
//! with `roamgate update` from a loopback mirror of a packaged target, and
//! the installed binary then serves its embedded web app.
//!
//! `--exec-prefix` runs every sandbox command through a prefix, such as an
//! arm64 container sharing the network and the sandbox's path: the proof of
//! a target this machine runs only under emulation.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Output, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::{Context, Result, bail, ensure};

use crate::targets::Target;

pub struct Proof<'a> {
    /// The Bun-built roamgate the sandbox starts from.
    pub from: &'a Path,
    /// The directory holding the target's package.
    pub dist: &'a Path,
    pub target: &'a Target,
    pub version: &'a str,
    /// The web app the package embeds.
    pub web: &'a Path,
    pub exec_prefix: Vec<String>,
    /// Keep the sandbox in this directory.
    pub keep: Option<PathBuf>,
}

/// A loopback HTTP server for the files of one directory; it records the
/// paths asked for.
fn mirror(dir: PathBuf) -> Result<(SocketAddr, Arc<Mutex<Vec<String>>>)> {
    let listener = TcpListener::bind("127.0.0.1:0")?;
    let address = listener.local_addr()?;
    let asked = Arc::new(Mutex::new(Vec::new()));
    let log = asked.clone();
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let _ = answer(stream, &dir, &log);
        }
    });
    Ok((address, asked))
}

fn answer(mut stream: TcpStream, dir: &Path, log: &Mutex<Vec<String>>) -> Result<()> {
    let mut reader = BufReader::new(stream.try_clone()?);
    let mut line = String::new();
    reader.read_line(&mut line)?;
    loop {
        let mut header = String::new();
        if reader.read_line(&mut header)? == 0 || header == "\r\n" {
            break;
        }
    }
    let mut parts = line.split_whitespace();
    let (method, path) = (
        parts.next().unwrap_or_default(),
        parts.next().unwrap_or_default(),
    );
    log.lock()
        .expect("mirror log")
        .push(format!("{method} {path}"));
    let name = path.trim_start_matches('/');
    let file =
        (method == "GET" && !name.is_empty() && !name.contains('/') && !name.starts_with('.'))
            .then(|| std::fs::read(dir.join(name)).ok())
            .flatten();
    match file {
        Some(body) => {
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nContent-Type: application/octet-stream\r\nConnection: close\r\n\r\n",
                body.len()
            )?;
            stream.write_all(&body)?;
        }
        None => stream.write_all(
            b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
        )?,
    }
    Ok(())
}

/// GET over loopback: status and body.
fn get(address: SocketAddr, path: &str) -> Result<(u16, Vec<u8>)> {
    let mut stream = TcpStream::connect_timeout(&address, Duration::from_secs(2))?;
    stream.set_read_timeout(Some(Duration::from_secs(30)))?;
    write!(
        stream,
        "GET {path} HTTP/1.1\r\nHost: {address}\r\nConnection: close\r\n\r\n"
    )?;
    let mut response = Vec::new();
    stream.read_to_end(&mut response)?;
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
    Ok((status, response[split + 4..].to_vec()))
}

struct Sandbox {
    root: PathBuf,
    home: PathBuf,
    bin: PathBuf,
    env: Vec<(String, String)>,
    prefix: Vec<String>,
}

impl Sandbox {
    fn command(&self, program: &Path, args: &[&str]) -> Command {
        let mut command = match self.prefix.split_first() {
            Some((first, rest)) => {
                let mut command = Command::new(first);
                command.args(rest).arg("env");
                command
            }
            None => Command::new("env"),
        };
        command.arg("-i");
        for (key, value) in &self.env {
            command.arg(format!("{key}={value}"));
        }
        command.arg(program).args(args).current_dir(&self.home);
        command
    }

    fn run(&self, program: &Path, args: &[&str]) -> Result<Output> {
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

    fn version(&self, program: &Path) -> Result<String> {
        let output = self.run(program, &["--version"])?;
        ensure!(
            output.status.success(),
            "{} --version failed",
            program.display()
        );
        let line = String::from_utf8_lossy(&output.stdout).trim().to_owned();
        line.strip_prefix("roamgate ")
            .map(str::to_owned)
            .with_context(|| format!("{} --version printed {line:?}", program.display()))
    }
}

struct Server(Child);

impl Drop for Server {
    fn drop(&mut self) {
        // SIGTERM, which a container prefix passes on; then make sure.
        let _ = Command::new("kill").arg(self.0.id().to_string()).status();
        let deadline = Instant::now() + Duration::from_secs(20);
        while Instant::now() < deadline {
            if let Ok(Some(_)) = self.0.try_wait() {
                return;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn free_port() -> Result<u16> {
    Ok(TcpListener::bind("127.0.0.1:0")?.local_addr()?.port())
}

pub fn run(proof: &Proof) -> Result<()> {
    let target = proof.target;
    ensure!(
        target.update,
        "roamgate update does not install {}",
        target.platform
    );
    let temp;
    let root = match &proof.keep {
        Some(dir) => {
            if dir.exists() {
                std::fs::remove_dir_all(dir)?;
            }
            std::fs::create_dir_all(dir)?;
            dir.canonicalize()?
        }
        None => {
            temp = TempDir::new()?;
            temp.0.clone()
        }
    };
    let home = root.join("home");
    let bin_dir = root.join("home/.local/bin");
    let mirror_dir = root.join("mirror");
    let tmp = root.join("tmp");
    for dir in [&home, &bin_dir, &mirror_dir, &tmp] {
        std::fs::create_dir_all(dir)?;
    }
    for name in [target.manifest_name(), target.latest_archive()] {
        std::fs::copy(proof.dist.join(&name), mirror_dir.join(&name))
            .with_context(|| format!("{name} in {}", proof.dist.display()))?;
    }
    let bin = bin_dir.join("roamgate");
    std::fs::copy(proof.from, &bin).with_context(|| proof.from.display().to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755))?;
    }
    let (mirror_address, asked) = mirror(mirror_dir)?;
    let path = if proof.exec_prefix.is_empty() {
        std::env::var("PATH").unwrap_or_default()
    } else {
        "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin".to_owned()
    };
    let dir = |sub: &str| home.join(sub).to_string_lossy().into_owned();
    let sandbox = Sandbox {
        root: root.clone(),
        home: home.clone(),
        bin: bin.clone(),
        env: vec![
            ("HOME".into(), home.to_string_lossy().into_owned()),
            ("PATH".into(), path),
            ("LANG".into(), "C.UTF-8".into()),
            ("TMPDIR".into(), tmp.to_string_lossy().into_owned()),
            ("XDG_CONFIG_HOME".into(), dir(".config")),
            ("XDG_DATA_HOME".into(), dir(".local/share")),
            ("XDG_CACHE_HOME".into(), dir(".cache")),
            ("XDG_STATE_HOME".into(), dir(".local/state")),
            // No host-spawn from a toolbox: the sandbox never reaches the host.
            ("ROAMGATE_HOST_SPAWN".into(), String::new()),
            (
                "ROAMGATE_UPDATE_BASE_URL".into(),
                format!("http://{mirror_address}"),
            ),
        ],
        prefix: proof.exec_prefix.clone(),
    };

    let old = sandbox.version(&sandbox.bin)?;
    ensure!(old != proof.version, "the sandbox already runs {old}");

    let check = sandbox.run(&sandbox.bin, &["update", "--check", "--json"])?;
    ensure!(check.status.success(), "roamgate update --check failed");
    let report: serde_json::Value =
        serde_json::from_slice(&check.stdout).context("update --check --json")?;
    ensure!(
        report["update_available"] == true
            && report["latest_version"] == proof.version
            && report["current_version"] == old.as_str()
            && report["platform"] == target.platform.as_str(),
        "update --check reported {report}"
    );

    let update = sandbox.run(&sandbox.bin, &["update"])?;
    ensure!(update.status.success(), "roamgate update failed");
    let said = String::from_utf8_lossy(&update.stdout);
    ensure!(
        said.contains(&format!(
            "Installed roamgate {} at {}",
            proof.version,
            bin.display()
        )),
        "roamgate update said {said:?}"
    );
    let asked = asked.lock().expect("mirror log").clone();
    for name in [target.manifest_name(), target.latest_archive()] {
        ensure!(
            asked.contains(&format!("GET /{name}")),
            "the updater never fetched {name}: {asked:?}"
        );
    }

    ensure!(
        sandbox.version(&bin)? == proof.version,
        "the update did not install {}",
        proof.version
    );
    let previous = bin.with_file_name("roamgate.previous");
    ensure!(
        sandbox.version(&previous)? == old,
        "roamgate.previous is not {old}"
    );
    let port = free_port()?;
    let port_text = port.to_string();
    let serve = ["--host", "127.0.0.1", "--port", &port_text];
    // A prefix may not pass signals on (a container started through a
    // toolbox's host-spawn): there the server ends itself.
    let mut command = if sandbox.prefix.is_empty() {
        sandbox.command(&bin, &serve)
    } else {
        let mut args = vec!["-s", "TERM", "90"];
        let bin_text = bin.to_string_lossy();
        args.push(&bin_text);
        args.extend(serve);
        sandbox.command(Path::new("timeout"), &args)
    };
    let server = Server(
        command
            .stdin(Stdio::null())
            .spawn()
            .context("starting the server")?,
    );
    let address: SocketAddr = ([127, 0, 0, 1], port).into();
    let deadline = Instant::now() + Duration::from_secs(60);
    let health = loop {
        match get(address, "/healthz") {
            Ok(answer) => break answer,
            Err(error) if Instant::now() > deadline => bail!("the server never answered: {error}"),
            Err(_) => std::thread::sleep(Duration::from_millis(250)),
        }
    };
    ensure!(
        health == (200, b"Ok".to_vec()),
        "/healthz answered {health:?}"
    );
    let index = std::fs::read(proof.web.join("index.html"))?;
    let (status, body) = get(address, "/")?;
    ensure!(
        status == 200 && body == index,
        "/ is not the embedded web app (status {status})"
    );
    let (status, body) = get(address, "/settings")?;
    ensure!(
        status == 200 && body == index,
        "an app route is not the web app (status {status})"
    );
    drop(server);

    eprintln!(
        "xtask: update proof for {}: roamgate {old} updated itself to {} from {}, kept {old} as roamgate.previous, and served the web app",
        target.platform, proof.version, mirror_address
    );
    Ok(())
}

struct TempDir(PathBuf);

impl TempDir {
    fn new() -> Result<Self> {
        let base = std::env::temp_dir();
        for attempt in 0..100u32 {
            let path = base.join(format!(
                "roamgate-update-proof-{}-{attempt}",
                std::process::id()
            ));
            if std::fs::create_dir(&path).is_ok() {
                return Ok(Self(path.canonicalize()?));
            }
        }
        bail!("no temporary directory in {}", base.display())
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
